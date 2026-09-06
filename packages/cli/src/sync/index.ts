import type Database from 'better-sqlite3'
import type { SyncRecord } from '@aiusage/core'
import { getUnsyncedRecords, isUploadableLocalRecord, markRecordsSynced, repairRecordProvenance } from '../db/records.js'
import { insertSyncedRecord, mergeSyncedRecordsIntoRecords } from '../db/synced-records.js'
import { mapStatsRecordToSyncRecord } from './mapper.js'
import { classifyPulledRecord, namespaceOwnerFromPath } from './ownership.js'
import type { SyncProgress } from './runtime.js'

export interface SyncBackend {
  readFile(path: string): Promise<string | null>
  writeFile(path: string, content: string): Promise<void>
  listFiles(): Promise<string[]>
  /** Optional: delete a single file from the backend */
  deleteFile?(path: string): Promise<void>
  /** Optional: delete all data files. Returns the number of files deleted. */
  deleteAllData?(): Promise<number>
  /** Optional: called before sync to fetch latest remote state (e.g. git pull) */
  prepare?(): Promise<void>
  /** Optional: called after all writes to push changes (e.g. git commit + push) */
  flush?(): Promise<boolean>
}

export interface SyncOptions {
  deviceInstanceId: string
  target: string
  consentVerified: boolean
  onProgress?: (progress: SyncProgress) => void
}

export interface SyncResult {
  status: 'ok' | 'blocked_pending_consent' | 'failed'
  pulledCount: number
  uploadedCount: number
  mergedCount: number
  /**
   * Remote lines ignored during pull because they did not belong to the
   * namespace they were read from (or were echoes of this device's own
   * records). Non-zero means a peer still has a contaminated namespace —
   * see `aiusage sync --repair`.
   */
  ignoredCount?: number
  /** Local rows whose provenance flag was corrected before uploading. */
  repairedCount?: number
  error?: string
}

export function getSyncPath(ts: string | number, deviceInstanceId: string): string {
  const d = new Date(ts)
  const date = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`
  return `${deviceInstanceId}/${date}.ndjson`
}

/** Parse a single ndjson line, normalising string timestamps. Returns null on bad input. */
export function parseSyncRecordLine(line: string): SyncRecord | null {
  try {
    const record: SyncRecord = JSON.parse(line)
    if (!record || typeof record !== 'object' || typeof record.id !== 'string') return null
    if (typeof record.ts === 'string') {
      (record as any).ts = new Date(record.ts).getTime()
    }
    if (typeof record.updatedAt === 'string') {
      (record as any).updatedAt = new Date(record.updatedAt).getTime()
    }
    return record
  } catch {
    return null
  }
}

/** Parse ndjson content into a Map<id, SyncRecord> */
export function parseNdjson(content: string): Map<string, SyncRecord> {
  const records = new Map<string, SyncRecord>()
  for (const line of content.split('\n').filter(Boolean)) {
    const record = parseSyncRecordLine(line)
    if (record) records.set(record.id, record)
  }
  return records
}

/** Merge new records into existing map; returns count of actually new/updated records */
function mergeRecords(
  existing: Map<string, SyncRecord>,
  newRecords: SyncRecord[],
): number {
  let changed = 0
  for (const record of newRecords) {
    const prev = existing.get(record.id)
    if (!prev || record.updatedAt > prev.updatedAt) {
      existing.set(record.id, record)
      changed++
    }
  }
  return changed
}

export class SyncOrchestrator {
  private db: Database.Database
  private backend: SyncBackend
  private options: SyncOptions

  constructor(db: Database.Database, backend: SyncBackend, options: SyncOptions) {
    this.db = db
    this.backend = backend
    this.options = options
  }

  async sync(): Promise<SyncResult> {
    if (!this.options.consentVerified) {
      return { status: 'blocked_pending_consent', pulledCount: 0, uploadedCount: 0, mergedCount: 0 }
    }

    try {
      // Provenance guard first: nothing stamped with another device's id may
      // ever be treated as local, whatever its source_file says.
      const repairedCount = repairRecordProvenance(this.db, this.options.deviceInstanceId)
      await this.backend.prepare?.()
      const { pulledCount, ignoredCount } = await this.pull()
      this.options.onProgress?.({ phase: 'merging', pulledCount })
      const mergedCount = mergeSyncedRecordsIntoRecords(this.db, this.options.deviceInstanceId)
      const uploadedCount = await this.upload()
      await this.backend.flush?.()
      this.options.onProgress?.({ phase: 'finalizing', pulledCount, uploadedCount })
      return { status: 'ok', pulledCount, uploadedCount, mergedCount, ignoredCount, repairedCount }
    } catch (error) {
      return {
        status: 'failed',
        pulledCount: 0,
        uploadedCount: 0,
        mergedCount: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  private async pull(): Promise<{ pulledCount: number; ignoredCount: number }> {
    const allPaths = await this.backend.listFiles()
    const localDevicePrefix = `${this.options.deviceInstanceId}/`
    const paths = allPaths.filter(p => !p.startsWith(localDevicePrefix))

    this.options.onProgress?.({
      phase: 'pulling',
      completedFiles: 0,
      totalFiles: paths.length,
      pulledCount: 0,
    })
    if (paths.length === 0) return { pulledCount: 0, ignoredCount: 0 }

    let totalPulled = 0
    let totalIgnored = 0

    for (const [index, path] of paths.entries()) {
      this.options.onProgress?.({
        phase: 'pulling',
        currentPath: path,
        completedFiles: index,
        totalFiles: paths.length,
        pulledCount: totalPulled,
      })
      const content = await this.backend.readFile(path)
      if (!content) continue

      const namespaceOwner = namespaceOwnerFromPath(path)
      for (const line of content.split('\n').filter(Boolean)) {
        const record = parseSyncRecordLine(line)
        if (!record) continue
        // Only records that belong to the namespace they were read from are
        // trusted. Anything else is a pre-fix echo whose authoritative copy
        // lives elsewhere (or is our own local row).
        if (classifyPulledRecord(record, namespaceOwner, this.options.deviceInstanceId)) {
          totalIgnored++
          continue
        }
        try {
          const changed = insertSyncedRecord(this.db, record)
          if (changed) totalPulled++
        } catch {}
      }

      this.options.onProgress?.({
        phase: 'pulling',
        currentPath: path,
        completedFiles: index + 1,
        totalFiles: paths.length,
        pulledCount: totalPulled,
      })
    }

    return { pulledCount: totalPulled, ignoredCount: totalIgnored }
  }

  private async uploadFile(
    path: string,
    localSyncRecords: SyncRecord[],
  ): Promise<number> {
    const existingContent = await this.backend.readFile(path)
    const existing = existingContent ? parseNdjson(existingContent) : new Map<string, SyncRecord>()

    const changedCount = mergeRecords(existing, localSyncRecords)
    if (changedCount === 0) return 0

    const content = Array.from(existing.values()).map(r => JSON.stringify(r)).join('\n') + '\n'
    await this.backend.writeFile(path, content)
    return changedCount
  }

  private async upload(): Promise<number> {
    const deviceInstanceId = this.options.deviceInstanceId
    // The query already restricts to origin = 'local' rows owned by this
    // device; the explicit filter is the last line of defence so that no
    // record stamped with another device's id can reach our namespace.
    const unsynced = getUnsyncedRecords(this.db, this.options.target, deviceInstanceId)
      .filter(record => isUploadableLocalRecord(record, deviceInstanceId))
    if (unsynced.length === 0) return 0

    // Group records by day. Every path is under *this* device's namespace.
    const byPath = new Map<string, typeof unsynced>()
    for (const record of unsynced) {
      const path = getSyncPath(record.ts, deviceInstanceId)
      if (!byPath.has(path)) byPath.set(path, [])
      byPath.get(path)!.push(record)
    }

    let totalUploaded = 0
    const uploads = Array.from(byPath.entries())

    this.options.onProgress?.({
      phase: 'uploading',
      completedFiles: 0,
      totalFiles: uploads.length,
      uploadedCount: 0,
    })

    for (const [index, [path, localRecords]] of uploads.entries()) {
      this.options.onProgress?.({
        phase: 'uploading',
        currentPath: path,
        completedFiles: index,
        totalFiles: uploads.length,
        uploadedCount: totalUploaded,
      })

      const localSyncRecords = localRecords.map(mapStatsRecordToSyncRecord)
      await this.uploadFile(path, localSyncRecords)
      totalUploaded += localRecords.length

      this.options.onProgress?.({
        phase: 'uploading',
        currentPath: path,
        completedFiles: index + 1,
        totalFiles: uploads.length,
        uploadedCount: totalUploaded,
      })
    }

    // Mark local records as synced
    const syncedAt = Date.now()
    markRecordsSynced(this.db, unsynced.map(r => r.id), syncedAt, this.options.target)

    return totalUploaded
  }
}
