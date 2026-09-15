import type Database from 'better-sqlite3'
import type { SyncRecord } from '@aiusage/core'
import {
  backfillUnknownDeviceInstanceId,
  getUnsyncedRecords,
  isUploadableLocalRecord,
  markRecordsSynced,
  repairRecordProvenance,
} from '../db/records.js'
import { deleteSyncedRecord, insertSyncedRecord, mergeSyncedRecordsIntoRecords } from '../db/synced-records.js'
import { clearRetiredWireIds, getRetiredWireIds, replaceNamespaceClaims } from '../db/sync-claims.js'
import { mapStatsRecordToSyncRecord } from './mapper.js'
import { cloudPush, cloudPull, CloudSyncError, type CloudPulledTombstone } from './cloud.js'
import type { SyncProgress } from './runtime.js'

export interface CloudSyncOptions {
  deviceInstanceId: string
  target?: string
  onProgress?: (progress: SyncProgress) => void
}

export interface CloudSyncResult {
  status: 'ok' | 'failed'
  pulledCount: number
  uploadedCount: number
  mergedCount: number
  syncGeneration: number
  /** Pulled rows removed because their origin device retracted them (tombstones). */
  prunedCount?: number
  /** Wire ids this device retracted from the server (see migration v14). */
  retiredCount?: number
  error?: string
}

const BATCH_SIZE = 500

export class CloudSyncOrchestrator {
  private db: Database.Database
  private options: CloudSyncOptions

  constructor(db: Database.Database, options: CloudSyncOptions) {
    this.db = db
    this.options = options
  }

  private get target(): string {
    return this.options.target ?? 'cloud'
  }

  async sync(syncGeneration: number = 1): Promise<CloudSyncResult> {
    try {
      // Step 0: provenance guard — rows stamped with another device's id are
      // never local, whatever their source_file says — then adopt pre-init rows.
      repairRecordProvenance(this.db, this.options.deviceInstanceId)
      backfillUnknownDeviceInstanceId(this.db, this.options.deviceInstanceId)

      // Step 1: Pull records from other devices
      this.options.onProgress?.({ phase: 'pulling', pulledCount: 0 })
      const pullResult = await this.pullAll(syncGeneration)

      // Step 2: Insert pulled records into synced_records.
      // The server returns every device's records, including our own. Our own
      // rows already live in `records` (origin = local) — and for tools whose
      // local id differs from the wire id (e.g. Claude Code message ids) they
      // would otherwise be merged back as fresh "local" rows and re-pushed.
      let insertedCount = 0
      const claimed = new Map<string, Set<string>>()
      for (const record of pullResult.records) {
        if (record.deviceInstanceId === this.options.deviceInstanceId) continue
        try {
          insertSyncedRecord(this.db, record)
          insertedCount++
        } catch {}
        const owner = record.deviceInstanceId || ''
        if (!claimed.has(owner)) claimed.set(owner, new Set())
        claimed.get(owner)!.add(record.id)
      }

      // Step 2a: The pull is complete (every page was read), so what the
      // server returned is exactly what this target claims per device. A
      // file-based target reconciling later must not delete rows that the
      // cloud still carries, and vice versa.
      this.db.transaction(() => {
        for (const [owner, ids] of claimed) replaceNamespaceClaims(this.db, this.target, owner, ids)
      })()

      // Step 2b: Apply tombstones — records their origin device retracted.
      // The row itself only goes once no other target claims it.
      let prunedCount = 0
      for (const tombstone of pullResult.tombstones) {
        if (!tombstone.id || tombstone.device_instance_id === this.options.deviceInstanceId) continue
        try {
          if (deleteSyncedRecord(this.db, this.target, tombstone.id)) prunedCount++
        } catch {}
      }

      // Step 3: Merge synced_records into records
      this.options.onProgress?.({ phase: 'merging', pulledCount: insertedCount })
      const mergedCount = mergeSyncedRecordsIntoRecords(this.db, this.options.deviceInstanceId)

      // Step 4: Push local records to cloud, then retract retired wire ids.
      this.options.onProgress?.({ phase: 'uploading', pulledCount: insertedCount })
      const uploadedCount = await this.push(syncGeneration)
      const retiredCount = await this.pushRetiredIds(syncGeneration)

      // Step 5: Mark local records as synced
      const unsynced = this.getUploadableRecords(this.target)
      if (unsynced.length > 0) {
        markRecordsSynced(this.db, unsynced.map(r => r.id), Date.now(), this.target)
      }

      this.options.onProgress?.({
        phase: 'finalizing',
        pulledCount: insertedCount,
        uploadedCount,
      })

      return {
        status: 'ok',
        pulledCount: insertedCount,
        uploadedCount,
        mergedCount,
        syncGeneration: pullResult.syncGeneration,
        prunedCount,
        retiredCount,
      }
    } catch (error) {
      const message = error instanceof CloudSyncError ? error.message
        : error instanceof Error ? error.message
        : 'Unknown error'

      return {
        status: 'failed',
        pulledCount: 0,
        uploadedCount: 0,
        mergedCount: 0,
        syncGeneration,
        error: message,
      }
    }
  }

  private async pullAll(syncGeneration: number): Promise<{ records: SyncRecord[]; tombstones: CloudPulledTombstone[]; syncGeneration: number }> {
    const allRecords: SyncRecord[] = []
    const allTombstones: CloudPulledTombstone[] = []
    let cursor: string | undefined
    let hasMore = true

    while (hasMore) {
      const result = await cloudPull(cursor, 1000)
      allRecords.push(...result.records)
      allTombstones.push(...(result.tombstones ?? []))
      cursor = result.nextCursor
      hasMore = result.hasMore
    }

    return { records: allRecords, tombstones: allTombstones, syncGeneration }
  }

  /**
   * Local rows eligible for push: parsed on this device and stamped with its
   * id. The query filters on provenance; the explicit predicate is the final
   * guard so nothing pulled from another device is ever pushed as ours.
   */
  private getUploadableRecords(target: string) {
    const deviceInstanceId = this.options.deviceInstanceId
    return getUnsyncedRecords(this.db, target, deviceInstanceId)
      .filter(record => isUploadableLocalRecord(record, deviceInstanceId))
  }

  private async push(syncGeneration: number): Promise<number> {
    const unsynced = this.getUploadableRecords(this.target)
    if (unsynced.length === 0) {
      return 0
    }

    // Convert to SyncRecord format
    const syncRecords = unsynced.map(mapStatsRecordToSyncRecord)

    for (let i = 0; i < syncRecords.length; i += BATCH_SIZE) {
      const batch = syncRecords.slice(i, i + BATCH_SIZE)
      await cloudPush(batch, [], this.options.deviceInstanceId, syncGeneration)
    }

    return unsynced.length
  }

  /**
   * The cloud store is upsert-only, so wire ids this device will never publish
   * again (migration v14: Antigravity/Trae records re-keyed to their parser
   * ids) are retracted with tombstones. Each batch is forgotten locally only
   * once the server accepted it, so an interrupted sync retries the rest.
   */
  private async pushRetiredIds(syncGeneration: number): Promise<number> {
    const retired = getRetiredWireIds(this.db, this.target)
    if (retired.length === 0) return 0
    const now = Date.now()
    for (let i = 0; i < retired.length; i += BATCH_SIZE) {
      const batch = retired.slice(i, i + BATCH_SIZE)
      await cloudPush([], batch.map(record_id => ({ record_id, updatedAt: now })), this.options.deviceInstanceId, syncGeneration)
      clearRetiredWireIds(this.db, this.target, batch)
    }
    return retired.length
  }
}
