import type Database from 'better-sqlite3'
import type { SyncRecord, SyncTombstone } from '@aiusage/core'
import { getUnsyncedRecords, isUploadableLocalRecord, markRecordsSynced, repairRecordProvenance } from '../db/records.js'
import { insertSyncedRecord, mergeSyncedRecordsIntoRecords } from '../db/synced-records.js'
import { mapStatsRecordToSyncRecord } from './mapper.js'
import { cloudPush, cloudPull, CloudSyncError } from './cloud.js'
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
  error?: string
}

export class CloudSyncOrchestrator {
  private db: Database.Database
  private options: CloudSyncOptions

  constructor(db: Database.Database, options: CloudSyncOptions) {
    this.db = db
    this.options = options
  }

  async sync(syncGeneration: number = 1): Promise<CloudSyncResult> {
    try {
      // Step 0: provenance guard — rows stamped with another device's id are
      // never local, whatever their source_file says.
      repairRecordProvenance(this.db, this.options.deviceInstanceId)

      // Step 1: Pull records from other devices
      this.options.onProgress?.({ phase: 'pulling', pulledCount: 0 })
      const pullResult = await this.pullAll(syncGeneration)

      // Step 2: Insert pulled records into synced_records.
      // The server returns every device's records, including our own. Our own
      // rows already live in `records` (origin = local) — and for tools whose
      // local id differs from the wire id (e.g. Claude Code message ids) they
      // would otherwise be merged back as fresh "local" rows and re-pushed.
      let insertedCount = 0
      for (const record of pullResult.records) {
        if (record.deviceInstanceId === this.options.deviceInstanceId) continue
        try {
          insertSyncedRecord(this.db, record)
          insertedCount++
        } catch {}
      }

      // Step 3: Merge synced_records into records
      this.options.onProgress?.({ phase: 'merging', pulledCount: insertedCount })
      const mergedCount = mergeSyncedRecordsIntoRecords(this.db, this.options.deviceInstanceId)

      // Step 4: Push local records to cloud
      this.options.onProgress?.({ phase: 'uploading', pulledCount: insertedCount })
      const uploadedCount = await this.push(syncGeneration)

      // Step 5: Mark local records as synced
      const target = this.options.target ?? 'cloud'
      const unsynced = this.getUploadableRecords(target)
      if (unsynced.length > 0) {
        markRecordsSynced(this.db, unsynced.map(r => r.id), Date.now(), target)
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

  private async pullAll(syncGeneration: number): Promise<{ records: SyncRecord[]; syncGeneration: number }> {
    const allRecords: SyncRecord[] = []
    let cursor: string | undefined
    let hasMore = true

    while (hasMore) {
      const result = await cloudPull(cursor, 1000)
      allRecords.push(...result.records)
      cursor = result.nextCursor
      hasMore = result.hasMore
    }

    return { records: allRecords, syncGeneration }
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
    const unsynced = this.getUploadableRecords(this.options.target ?? 'cloud')
    if (unsynced.length === 0) {
      return 0
    }

    // Convert to SyncRecord format
    const syncRecords = unsynced.map(mapStatsRecordToSyncRecord)

    // Push in batches of 500
    const BATCH_SIZE = 500
    for (let i = 0; i < syncRecords.length; i += BATCH_SIZE) {
      const batch = syncRecords.slice(i, i + BATCH_SIZE)
      await cloudPush(batch, [], this.options.deviceInstanceId, syncGeneration)
    }

    return unsynced.length
  }
}
