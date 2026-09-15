import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { SyncRecord } from '@aiusage/core'
import {
  backfillUnknownDeviceInstanceId,
  getLocalRecordsForDevice,
  getUnsyncedRecords,
  isUploadableLocalRecord,
  markRecordsSynced,
  repairRecordProvenance,
  UNKNOWN_DEVICE_INSTANCE_ID,
} from '../db/records.js'
import {
  insertSyncedRecord,
  mergeSyncedRecordsIntoRecords,
  pruneUnclaimedUnknownSyncedRecords,
  reconcileSyncedNamespace,
} from '../db/synced-records.js'
import { clearRetiredWireIds, forgetNamespace, getSeenNamespaces, recordSeenNamespaces } from '../db/sync-namespaces.js'
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
  /**
   * Optional: hex MD5 digests of file contents keyed by path, for every file
   * the backend can report one for cheaply (e.g. S3 ETags from a listing).
   * Files missing from the map are compared by reading them.
   */
  listFileDigests?(): Promise<Map<string, string>>
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
  /** Pulled rows removed because they no longer exist in their owner's namespace. */
  prunedCount?: number
  /** Lines removed from this device's own namespace because the record no longer exists locally. */
  retiredCount?: number
  /** Local records that mapped to a wire id already taken by another local record (the newer one wins). */
  collisionCount?: number
  /** Files written or deleted in this device's namespace. */
  writtenFiles?: number
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

/**
 * Canonical file content for a set of wire records: one JSON line per record,
 * sorted by id. Deterministic so that unchanged snapshots hash identically
 * and no-op syncs never rewrite a file.
 */
export function serializeSnapshot(records: SyncRecord[]): string {
  const sorted = [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return sorted.map(r => JSON.stringify(r)).join('\n') + '\n'
}

export function contentDigest(content: string): string {
  return createHash('md5').update(content, 'utf8').digest('hex')
}

/** True when `existing` already holds exactly `records` (order-insensitive). */
function sameSnapshot(existing: Map<string, SyncRecord>, records: SyncRecord[]): boolean {
  if (existing.size !== records.length) return false
  for (const record of records) {
    const prev = existing.get(record.id)
    if (!prev || JSON.stringify(prev) !== JSON.stringify(record)) return false
  }
  return true
}

export interface LocalSnapshot {
  /** Wire records keyed by id, one per local record (collisions resolved to the newest). */
  records: Map<string, SyncRecord>
  /** Local records that lost a wire-id collision. */
  collisions: Array<{ wireId: string; recordIds: string[] }>
}

/**
 * Build the authoritative wire snapshot of this device's local records. Wire
 * ids are expected to be unique; if two local rows still map to the same id
 * the most recently updated one is kept and the clash is reported so it can
 * surface in the sync result and in `sync --repair`.
 */
export function buildLocalSnapshot(db: Database.Database, deviceInstanceId: string): LocalSnapshot {
  const records = new Map<string, SyncRecord>()
  const losers = new Map<string, string[]>()
  const winnerLocalId = new Map<string, string>()
  for (const record of getLocalRecordsForDevice(db, deviceInstanceId)) {
    if (!isUploadableLocalRecord(record, deviceInstanceId)) continue
    const wire = mapStatsRecordToSyncRecord(record)
    const prev = records.get(wire.id)
    if (!prev) {
      records.set(wire.id, wire)
      winnerLocalId.set(wire.id, record.id)
      continue
    }
    const list = losers.get(wire.id) ?? []
    if (wire.updatedAt > prev.updatedAt) {
      list.push(winnerLocalId.get(wire.id)!)
      records.set(wire.id, wire)
      winnerLocalId.set(wire.id, record.id)
    } else {
      list.push(record.id)
    }
    losers.set(wire.id, list)
  }
  const collisions = Array.from(losers.entries()).map(([wireId, recordIds]) => ({ wireId, recordIds }))
  return { records, collisions }
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
      // ever be treated as local, whatever its source_file says. Then adopt
      // the pre-init rows this device parsed before it had an id.
      const repairedCount = repairRecordProvenance(this.db, this.options.deviceInstanceId)
      backfillUnknownDeviceInstanceId(this.db, this.options.deviceInstanceId)
      await this.backend.prepare?.()
      const listing = await this.backend.listFiles()
      const { pulledCount, ignoredCount, prunedCount } = await this.pull(listing)
      this.options.onProgress?.({ phase: 'merging', pulledCount })
      const mergedCount = mergeSyncedRecordsIntoRecords(this.db, this.options.deviceInstanceId)
      const upload = await this.upload(listing)
      await this.backend.flush?.()
      this.options.onProgress?.({ phase: 'finalizing', pulledCount, uploadedCount: upload.uploadedCount })
      return {
        status: 'ok',
        pulledCount,
        uploadedCount: upload.uploadedCount,
        mergedCount,
        ignoredCount,
        repairedCount,
        prunedCount,
        retiredCount: upload.retiredCount,
        collisionCount: upload.collisionCount,
        writtenFiles: upload.writtenFiles,
      }
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

  /**
   * Mirror every foreign namespace. Each namespace is read completely; the
   * ids seen there are the authoritative set for that device, so local rows
   * attributed to the device that are missing remotely are pruned. Namespaces
   * seen on this target before but absent now were deleted remotely and are
   * pruned entirely. Our own namespace is never read here.
   */
  private async pull(allPaths: string[]): Promise<{ pulledCount: number; ignoredCount: number; prunedCount: number }> {
    const own = this.options.deviceInstanceId
    const localDevicePrefix = `${own}/`
    const paths = allPaths.filter(p => !p.startsWith(localDevicePrefix))

    this.options.onProgress?.({
      phase: 'pulling',
      completedFiles: 0,
      totalFiles: paths.length,
      pulledCount: 0,
    })

    let totalPulled = 0
    let totalIgnored = 0
    const remoteIds = new Map<string, Set<string>>()
    for (const path of paths) {
      const owner = namespaceOwnerFromPath(path)
      if (!remoteIds.has(owner)) remoteIds.set(owner, new Set())
    }

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
      const ids = remoteIds.get(namespaceOwner)!
      for (const line of content.split('\n').filter(Boolean)) {
        const record = parseSyncRecordLine(line)
        if (!record) continue
        // Only records that belong to the namespace they were read from are
        // trusted. Anything else is a pre-fix echo whose authoritative copy
        // lives elsewhere (or is our own local row).
        if (classifyPulledRecord(record, namespaceOwner, own)) {
          totalIgnored++
          continue
        }
        // Lines written before the origin device had an id belong to the
        // namespace owner; storing them as 'unknown' would surface a phantom
        // device.
        if (!record.deviceInstanceId || record.deviceInstanceId === UNKNOWN_DEVICE_INSTANCE_ID) {
          record.deviceInstanceId = namespaceOwner
        }
        ids.add(record.id)
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

    // Reconcile: namespaces present now, plus namespaces previously seen on
    // this target that have since disappeared.
    let prunedCount = 0
    const target = this.options.target
    const seenBefore = getSeenNamespaces(this.db, target)
    const owners = new Set<string>([...remoteIds.keys(), ...seenBefore])
    owners.delete(own)
    const claimedIds = new Set<string>()
    for (const owner of owners) {
      const ids = remoteIds.get(owner) ?? new Set<string>()
      for (const id of ids) claimedIds.add(id)
      prunedCount += reconcileSyncedNamespace(this.db, owner, ids)
      if (!remoteIds.has(owner)) forgetNamespace(this.db, target, owner)
    }
    prunedCount += pruneUnclaimedUnknownSyncedRecords(this.db, claimedIds)
    recordSeenNamespaces(this.db, target, remoteIds.keys())

    return { pulledCount: totalPulled, ignoredCount: totalIgnored, prunedCount }
  }

  /**
   * Publish this device's namespace as an authoritative snapshot of its local
   * records. Every day file is compared with the remote copy (by digest when
   * the backend can provide one, otherwise by content) and only written when
   * it differs; files for days that no longer have any local record are
   * removed. Nothing outside `<deviceInstanceId>/` is ever touched.
   */
  private async upload(allPaths: string[]): Promise<{ uploadedCount: number; retiredCount: number; collisionCount: number; writtenFiles: number }> {
    const deviceInstanceId = this.options.deviceInstanceId
    const target = this.options.target
    const prefix = `${deviceInstanceId}/`

    // The query already restricts to origin = 'local' rows owned by this
    // device; the explicit filter is the last line of defence so that no
    // record stamped with another device's id can reach our namespace.
    const unsynced = getUnsyncedRecords(this.db, target, deviceInstanceId)
      .filter(record => isUploadableLocalRecord(record, deviceInstanceId))

    const snapshot = buildLocalSnapshot(this.db, deviceInstanceId)
    const byPath = new Map<string, SyncRecord[]>()
    for (const wire of snapshot.records.values()) {
      const path = getSyncPath(wire.ts, deviceInstanceId)
      if (!path.startsWith(prefix)) continue
      if (!byPath.has(path)) byPath.set(path, [])
      byPath.get(path)!.push(wire)
    }

    const ownPaths = allPaths.filter(p => p.startsWith(prefix))
    const ownPathSet = new Set(ownPaths)
    const stalePaths = ownPaths.filter(p => !byPath.has(p))
    const uploads = Array.from(byPath.entries()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const totalFiles = uploads.length + stalePaths.length
    const digests = await this.backend.listFileDigests?.()

    let retiredCount = 0
    let writtenFiles = 0
    let completed = 0
    let uploadedCount = 0

    this.options.onProgress?.({ phase: 'uploading', completedFiles: 0, totalFiles, uploadedCount: 0 })

    for (const [path, records] of uploads) {
      this.options.onProgress?.({ phase: 'uploading', currentPath: path, completedFiles: completed, totalFiles, uploadedCount })
      const content = serializeSnapshot(records)
      const digest = digests?.get(path)
      let unchanged = digest !== undefined && digest === contentDigest(content)
      if (!unchanged && ownPathSet.has(path)) {
        const existingContent = await this.backend.readFile(path)
        const existing = existingContent ? parseNdjson(existingContent) : new Map<string, SyncRecord>()
        unchanged = sameSnapshot(existing, records)
        if (!unchanged) {
          for (const id of existing.keys()) if (!snapshot.records.has(id)) retiredCount++
        }
      }
      if (!unchanged) {
        await this.backend.writeFile(path, content)
        writtenFiles++
      }
      uploadedCount += records.length
      completed++
      this.options.onProgress?.({ phase: 'uploading', currentPath: path, completedFiles: completed, totalFiles, uploadedCount })
    }

    // Deletions come last so an interrupted sync never leaves the namespace
    // with fewer records than either the old or the new snapshot.
    for (const path of stalePaths) {
      this.options.onProgress?.({ phase: 'uploading', currentPath: path, completedFiles: completed, totalFiles, uploadedCount })
      const existingContent = await this.backend.readFile(path)
      if (existingContent) retiredCount += parseNdjson(existingContent).size
      if (this.backend.deleteFile) await this.backend.deleteFile(path)
      else await this.backend.writeFile(path, '')
      writtenFiles++
      completed++
    }

    // Bookkeeping: rows newly published (or changed since their last upload)
    // are what `uploadedCount` reports; retired wire ids are moot once the
    // snapshot has been rewritten.
    markRecordsSynced(this.db, unsynced.map(r => r.id), Date.now(), target)
    clearRetiredWireIds(this.db, target)

    return { uploadedCount: unsynced.length, retiredCount, collisionCount: snapshot.collisions.length, writtenFiles }
  }
}
