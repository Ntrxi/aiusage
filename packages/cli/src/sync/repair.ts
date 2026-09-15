import type Database from 'better-sqlite3'
import type { SyncRecord } from '@aiusage/core'
import { generateSessionKey } from '@aiusage/core'
import { UNKNOWN_DEVICE_INSTANCE_ID } from '../db/records.js'
import { getUnclaimedSyncedRecords } from '../db/synced-records.js'
import { dropDanglingClaims } from '../db/sync-claims.js'
import type { SyncBackend } from './index.js'
import { buildLocalSnapshot } from './index.js'
import { buildManifest, isManifestPath, manifestPath, parseNdjsonLines, parseSyncRecordLine, serializeManifest } from './manifest.js'
import { namespaceOwnerFromPath } from './ownership.js'

/**
 * Opt-in cleanup of state left behind by earlier sync bugs.
 *
 * Before `records.origin` existed, records pulled from device A were merged
 * into device B's `records` table and — because their `source_file` no longer
 * started with `synced/` — re-uploaded under B's namespace as if B had
 * produced them. Each such round trip produced an *echo*: a copy of the record
 * with a colliding id (`sha256(A, sourceFile, 0)`) and a session key that is
 * the hash of the original's session key. Echoes bounced back to A and to any
 * third device, double-counting usage everywhere.
 *
 * Before namespaces became authoritative snapshots, upload only ever merged
 * into the remote files, so a record deleted or re-keyed locally (cache
 * rebuild, id-algorithm change, Antigravity wire-id collision fix) left a
 * *stale* line behind in the device's own namespace, and two local records
 * mapping to the same wire id left one of them missing (*collision*).
 *
 * Nothing in this module runs automatically. `aiusage sync --repair` reports
 * what would change; `--apply` performs it. Every rule below is deterministic:
 *
 *  - **foreign-namespace line**: a remote line whose `deviceInstanceId` is a
 *    concrete id different from the namespace it sits in. Only the owning
 *    device ever writes to a namespace, and post-fix it only writes its own
 *    records, so such a line can only be a pre-fix echo. Its authoritative copy
 *    is in the other device's namespace.
 *  - **echo (session-key chain)**: a row/line E for which a known session key
 *    K exists such that `generateSessionKey(E.device, K) === E.sessionKey`. The mapper
 *    derives a wire session key as `sha256(device + '\0' + sessionId)[0:24]`;
 *    a merged row's `session_id` *is* the parent's session key, so re-uploading
 *    it hashes the hash. A genuine record's session id is a tool-generated
 *    identifier, never another session's 24-hex hash, so this relation cannot
 *    hold by accident.
 *  - **own-device echo**: a `synced_records` row stamped with this device's own
 *    id. Pull never reads our own namespace, so our id can only appear there by
 *    bouncing through another device. The authoritative row is in `records`.
 *  - **stale line**: a line in *this device's* namespace whose id is not
 *    produced by any local record. The namespace is a snapshot of the local
 *    database, so the line describes a record that no longer exists (or now
 *    travels under a different id). Only this device can judge its own
 *    namespace; other namespaces are never checked for staleness.
 *  - **duplicate line**: the same wire id appearing more than once in one
 *    namespace (across day files). Only the most recently updated copy is
 *    kept.
 *  - **wire-id collision** (report only): two local records that map to the
 *    same wire id. The mapper is expected to make this impossible; a non-zero
 *    count is a parser or mapper bug worth reporting.
 *  - **orphaned pulled row**: a `synced_records` row that no sync target
 *    claims (it was pulled before per-target claims existed, migration v14)
 *    and whose device has no namespace on the configured target. Sync cannot
 *    tell whether another, older target still carries it, so it leaves such
 *    rows alone unless this is the only target the device ever used; repair
 *    reports them and removes them on request. If the device does publish
 *    elsewhere, syncing that target first re-establishes its claims.
 *
 * Deleting an echo never loses usage: by construction the parent it was
 * derived from still exists (or is itself an echo whose parent exists).
 * Deleting a stale line never loses usage either: the local database is the
 * source of truth for this device, and the next sync would drop it anyway.
 */

/**
 * Every session key known to the system (local rows, pulled rows, remote
 * lines). A record is an echo when its session key is the hash of one of
 * these keys under its own device alias — the exact transformation the mapper
 * applies when a merged row (whose `session_id` is already a key) is
 * re-uploaded. Usage fields are deliberately not compared: backfills rewrite
 * model/cost/timestamps on the origin device after an echo was taken, and the
 * chain relation alone is already a hash pre-image argument.
 */
export class SessionKeyChain {
  private readonly keys = new Set<string>()
  /** device alias → { generateSessionKey(alias, k) : k ∈ keys }, built lazily. */
  private readonly hashedByDevice = new Map<string, Set<string>>()

  add(sessionKey: string): void {
    if (!sessionKey) return
    if (!this.keys.has(sessionKey)) {
      this.keys.add(sessionKey)
      this.hashedByDevice.clear()
    }
  }

  get size(): number {
    return this.keys.size
  }

  /** True when `record.sessionKey` is `generateSessionKey(record.device, k)` for a known key `k`. */
  isEcho(record: { device: string; sessionKey: string }): boolean {
    if (!record.sessionKey) return false
    let hashed = this.hashedByDevice.get(record.device)
    if (!hashed) {
      hashed = new Set()
      for (const k of this.keys) hashed.add(generateSessionKey(record.device, k))
      this.hashedByDevice.set(record.device, hashed)
    }
    return hashed.has(record.sessionKey)
  }
}

// ---------------------------------------------------------------------------
// Local database
// ---------------------------------------------------------------------------

export interface LocalRepairPlan {
  /** `records` rows still flagged local that are provably pulled copies. */
  reflagRecordIds: string[]
  /** `synced_records` rows that are echoes (own-device or chain). */
  echoSyncedIds: string[]
  /** `records` rows (origin = synced) that were merged from those echoes. */
  echoMergedIds: string[]
  /** `sync_record_state` rows attached to non-local records. */
  staleSyncStateCount: number
  /** Local records sharing a wire id (report only; the mapper should make this impossible). */
  wireIdCollisions: Array<{ wireId: string; recordIds: string[] }>
  /** Unclaimed pulled rows whose device is absent from the configured target. */
  orphanedSyncedIds: string[]
  /** The devices those rows are attributed to. */
  orphanedDevices: string[]
}

interface SyncedRow {
  id: string
  device: string
  device_instance_id: string
  session_key: string
}

/**
 * Collect every session key this device knows about: its own local rows
 * (wire key = hash(device, sessionId)), all pulled rows, and — when provided —
 * every line read from the remote backend.
 */
function buildSessionKeyChain(db: Database.Database, remoteLines?: Iterable<SyncRecord>): SessionKeyChain {
  const chain = new SessionKeyChain()
  const localRows = db.prepare(`
    SELECT DISTINCT device, session_id FROM records WHERE origin = 'local'
  `).all() as Array<{ device: string; session_id: string }>
  for (const r of localRows) chain.add(generateSessionKey(r.device, r.session_id))
  const syncedRows = db.prepare(`SELECT DISTINCT session_key FROM synced_records`).all() as Array<{ session_key: string }>
  for (const r of syncedRows) chain.add(r.session_key)
  if (remoteLines) {
    for (const line of remoteLines) chain.add(line.sessionKey)
  }
  return chain
}

export function planLocalRepair(
  db: Database.Database,
  deviceInstanceId: string,
  remoteLines?: Iterable<SyncRecord>,
  /** Namespace owners present on the configured target; omit when unknown (cloud). */
  presentOwners?: Set<string>,
): LocalRepairPlan {
  // 1. Provenance: local-flagged rows that are provably pulled copies.
  const reflagRows = db.prepare(`
    SELECT id FROM records
    WHERE origin = 'local'
      AND (
        source_file LIKE 'synced/%'
        OR (device_instance_id != @deviceInstanceId AND device_instance_id != '${UNKNOWN_DEVICE_INSTANCE_ID}')
        OR EXISTS (
          SELECT 1 FROM synced_records s
          WHERE s.id = records.id AND s.session_key = records.session_id
        )
      )
  `).all({ deviceInstanceId }) as Array<{ id: string }>
  const reflagRecordIds = reflagRows.map(r => r.id)

  // 2. Echoes in synced_records.
  const chain = buildSessionKeyChain(db, remoteLines)
  const syncedRows = db.prepare(`
    SELECT id, device, device_instance_id, session_key FROM synced_records
  `).all() as SyncedRow[]
  const echoSyncedIds: string[] = []
  for (const row of syncedRows) {
    const ownDevice = row.device_instance_id === deviceInstanceId
    const echoed = chain.isEcho({ device: row.device, sessionKey: row.session_key })
    if (ownDevice || echoed) echoSyncedIds.push(row.id)
  }

  // 3. records rows merged from those echoes (never local: origin = synced,
  //    or about to be re-flagged as such).
  const echoSet = new Set(echoSyncedIds)
  const reflagSet = new Set(reflagRecordIds)
  const mergedRows = db.prepare(`SELECT id, origin FROM records`).all() as Array<{ id: string; origin: string }>
  const echoMergedIds = mergedRows
    .filter(r => echoSet.has(r.id) && (r.origin === 'synced' || reflagSet.has(r.id)))
    .map(r => r.id)

  // 4. Stale sync bookkeeping.
  const stale = db.prepare(`
    SELECT COUNT(*) AS n FROM sync_record_state
    WHERE record_id IN (SELECT id FROM records WHERE origin = 'synced')
  `).get() as { n: number }

  // 5. Wire-id collisions among this device's own records.
  const { collisions } = buildLocalSnapshot(db, deviceInstanceId)

  // 6. Orphaned pulled rows: unclaimed, and their device is not on the target.
  const orphanedSyncedIds: string[] = []
  const orphanedDevices: string[] = []
  if (presentOwners) {
    for (const [owner, ids] of getUnclaimedSyncedRecords(db)) {
      if (owner === deviceInstanceId || owner === UNKNOWN_DEVICE_INSTANCE_ID || owner === '' || presentOwners.has(owner)) continue
      const fresh = ids.filter(id => !echoSet.has(id))
      if (fresh.length === 0) continue
      orphanedDevices.push(owner)
      orphanedSyncedIds.push(...fresh)
    }
  }

  return {
    reflagRecordIds,
    echoSyncedIds,
    echoMergedIds,
    staleSyncStateCount: stale.n + reflagRecordIds.length,
    wireIdCollisions: collisions,
    orphanedSyncedIds,
    orphanedDevices,
  }
}

export function applyLocalRepair(db: Database.Database, plan: LocalRepairPlan): void {
  const reflag = db.prepare(`UPDATE records SET origin = 'synced' WHERE id = ?`)
  const delMerged = db.prepare(`DELETE FROM records WHERE id = ? AND origin = 'synced'`)
  const delSynced = db.prepare(`DELETE FROM synced_records WHERE id = ?`)
  db.transaction(() => {
    for (const id of plan.reflagRecordIds) reflag.run(id)
    for (const id of plan.echoMergedIds) delMerged.run(id)
    for (const id of plan.echoSyncedIds) delSynced.run(id)
    for (const id of plan.orphanedSyncedIds) { delMerged.run(id); delSynced.run(id) }
    db.prepare(`
      DELETE FROM sync_record_state
      WHERE record_id IN (SELECT id FROM records WHERE origin = 'synced')
         OR record_id NOT IN (SELECT id FROM records)
    `).run()
    // A claim describes a row that is mirrored; the rows removed above are
    // not, so their claims go with them (a dangling claim would keep a later
    // pull of the same id from ever being pruned).
    dropDanglingClaims(db)
  })()
}

// ---------------------------------------------------------------------------
// Remote namespaces (file-based backends)
// ---------------------------------------------------------------------------

export interface RemoteFilePlan {
  path: string
  owner: string
  totalLines: number
  foreignLines: number
  echoLines: number
  /** Lines in this device's own namespace with no matching local record. */
  staleLines: number
  /** Older copies of an id that also appears elsewhere in the namespace. */
  duplicateLines: number
  /** Lines that survive; the file is deleted when this is empty. */
  keptLines: string[]
}

export interface RemoteNamespaceSummary {
  owner: string
  files: number
  lines: number
  foreignLines: number
  echoLines: number
  staleLines: number
  duplicateLines: number
}

export interface RemoteRepairPlan {
  scannedFiles: number
  scannedLines: number
  /** Every parsed line across all namespaces (used to seed the local parent index). */
  allRecords: SyncRecord[]
  files: RemoteFilePlan[]
  namespaces: RemoteNamespaceSummary[]
  /** Namespace owners that have at least one data file on the target. */
  presentOwners: Set<string>
  /**
   * Content of every namespace after the plan is applied, keyed by owner then
   * by path relative to the namespace. Used to rewrite the manifest of a
   * repaired namespace so peers keep verifying it.
   */
  finalFiles: Map<string, Map<string, SyncRecord[]>>
  /** Owners whose namespace carried a manifest when scanned. */
  ownersWithManifest: Set<string>
}

export interface RemoteRepairOptions {
  deviceInstanceId: string
  /** Repair every namespace, not just this device's own. */
  allNamespaces?: boolean
  /** Extra known session keys (e.g. this device's local rows) to recognise echoes of. */
  sessionKeys?: SessionKeyChain
  /**
   * Wire ids this device currently publishes. When given, lines in the
   * device's own namespace with any other id are stale. Other namespaces are
   * never judged for staleness: only their owner knows their local state.
   */
  ownWireIds?: Set<string>
}

export async function planRemoteRepair(backend: SyncBackend, options: RemoteRepairOptions): Promise<RemoteRepairPlan> {
  const paths = (await backend.listFiles()).filter(p => p.endsWith('.ndjson') && !isManifestPath(p)).sort()
  const chain = options.sessionKeys ?? new SessionKeyChain()
  const parsed: Array<{ path: string; owner: string; lines: Array<{ raw: string; record: SyncRecord | null }> }> = []
  const allRecords: SyncRecord[] = []
  const presentOwners = new Set<string>()
  const ownersWithManifest = new Set<string>()

  for (const path of paths) {
    const owner = namespaceOwnerFromPath(path)
    if (!presentOwners.has(owner)) {
      presentOwners.add(owner)
      if ((await backend.readFile(manifestPath(owner))) !== null) ownersWithManifest.add(owner)
    }
    const content = await backend.readFile(path)
    if (!content) continue
    const lines = content.split('\n').filter(Boolean).map(raw => {
      const record = parseSyncRecordLine(raw)
      if (record) {
        chain.add(record.sessionKey)
        allRecords.push(record)
      }
      return { raw, record }
    })
    parsed.push({ path, owner, lines })
  }

  // Duplicate detection: per namespace, the copy of an id with the highest
  // updatedAt (ties: the first in path order) is the one to keep.
  const best = new Map<string, Map<string, { path: string; index: number; updatedAt: number }>>()
  for (const file of parsed) {
    let perOwner = best.get(file.owner)
    if (!perOwner) best.set(file.owner, perOwner = new Map())
    file.lines.forEach(({ record }, index) => {
      if (!record) return
      const prev = perOwner!.get(record.id)
      if (!prev || record.updatedAt > prev.updatedAt) perOwner!.set(record.id, { path: file.path, index, updatedAt: record.updatedAt })
    })
  }

  const files: RemoteFilePlan[] = []
  const perNamespace = new Map<string, RemoteNamespaceSummary>()
  const finalFiles = new Map<string, Map<string, SyncRecord[]>>()

  for (const file of parsed) {
    const isOwn = file.owner === options.deviceInstanceId
    const repairable = options.allNamespaces || isOwn
    const ns = perNamespace.get(file.owner) ?? { owner: file.owner, files: 0, lines: 0, foreignLines: 0, echoLines: 0, staleLines: 0, duplicateLines: 0 }
    ns.files++
    ns.lines += file.lines.length
    perNamespace.set(file.owner, ns)
    const winners = best.get(file.owner)!

    let foreignLines = 0
    let echoLines = 0
    let staleLines = 0
    let duplicateLines = 0
    const keptLines: string[] = []
    file.lines.forEach(({ raw, record }, index) => {
      if (!record) { keptLines.push(raw); return }
      const did = record.deviceInstanceId
      const foreign = !!did && did !== UNKNOWN_DEVICE_INSTANCE_ID && did !== file.owner
      const echo = !foreign && chain.isEcho(record)
      const winner = winners.get(record.id)!
      const duplicate = !foreign && !echo && !(winner.path === file.path && winner.index === index)
      const stale = !foreign && !echo && !duplicate && isOwn && options.ownWireIds !== undefined && !options.ownWireIds.has(record.id)
      if (foreign) foreignLines++
      else if (echo) echoLines++
      else if (duplicate) duplicateLines++
      else if (stale) staleLines++
      else keptLines.push(raw)
    })
    ns.foreignLines += foreignLines
    ns.echoLines += echoLines
    ns.staleLines += staleLines
    ns.duplicateLines += duplicateLines
    const changed = repairable && (foreignLines > 0 || echoLines > 0 || staleLines > 0 || duplicateLines > 0)
    if (changed) {
      files.push({ path: file.path, owner: file.owner, totalLines: file.lines.length, foreignLines, echoLines, staleLines, duplicateLines, keptLines })
    }
    const finalRecords = changed
      ? parseNdjsonLines(keptLines.join('\n')).records
      : file.lines.flatMap(l => (l.record ? [l.record] : []))
    if (finalRecords.length > 0) {
      let perOwner = finalFiles.get(file.owner)
      if (!perOwner) finalFiles.set(file.owner, perOwner = new Map())
      perOwner.set(file.path.slice(file.owner.length + 1), finalRecords)
    }
  }

  return {
    scannedFiles: parsed.length,
    scannedLines: allRecords.length,
    allRecords,
    files,
    namespaces: Array.from(perNamespace.values()).sort((a, b) => a.owner.localeCompare(b.owner)),
    presentOwners,
    finalFiles,
    ownersWithManifest,
  }
}

/**
 * Rewrite the planned files. Files are written before any deletion, and the
 * manifest of every namespace that changed is refreshed afterwards so peers
 * keep verifying it — for this device's own namespace always, for other
 * namespaces only when they already carried one (a namespace still written by
 * a pre-manifest client must not acquire a manifest that client would never
 * maintain).
 */
export async function applyRemoteRepair(backend: SyncBackend, plan: RemoteRepairPlan, deviceInstanceId?: string): Promise<{ rewritten: number; deleted: number }> {
  let rewritten = 0
  let deleted = 0
  const touchedOwners = new Set<string>()
  for (const file of plan.files) {
    if (file.keptLines.length > 0) {
      await backend.writeFile(file.path, file.keptLines.join('\n') + '\n')
      rewritten++
      touchedOwners.add(file.owner)
    }
  }
  for (const owner of touchedOwners) {
    if (owner !== deviceInstanceId && !plan.ownersWithManifest.has(owner)) continue
    const files = plan.finalFiles.get(owner) ?? new Map<string, SyncRecord[]>()
    await backend.writeFile(manifestPath(owner), serializeManifest(buildManifest(files)))
  }
  for (const file of plan.files) {
    if (file.keptLines.length > 0) continue
    if (backend.deleteFile) await backend.deleteFile(file.path)
    else await backend.writeFile(file.path, '')
    deleted++
    if ((file.owner === deviceInstanceId || plan.ownersWithManifest.has(file.owner)) && !touchedOwners.has(file.owner)) {
      touchedOwners.add(file.owner)
      const files = plan.finalFiles.get(file.owner) ?? new Map<string, SyncRecord[]>()
      await backend.writeFile(manifestPath(file.owner), serializeManifest(buildManifest(files)))
    }
  }
  return { rewritten, deleted }
}

// ---------------------------------------------------------------------------
// Combined entry point
// ---------------------------------------------------------------------------

export interface RepairReport {
  deviceInstanceId: string
  local: LocalRepairPlan
  remote: RemoteRepairPlan | null
  applied: boolean
  remoteResult?: { rewritten: number; deleted: number; flushed: boolean }
}

export interface RepairOptions {
  deviceInstanceId: string
  /** The configured sync target (informational; orphan detection uses the backend listing). */
  target?: string
  /** File-based backend; omit for cloud (local repair only). */
  backend?: SyncBackend
  allNamespaces?: boolean
  apply?: boolean
}

/**
 * Analyse (and optionally repair) contamination. Remote lines are read first
 * so that local echo detection can see parents that only exist remotely.
 */
export async function repairSyncContamination(db: Database.Database, options: RepairOptions): Promise<RepairReport> {
  const { deviceInstanceId, backend } = options
  let remote: RemoteRepairPlan | null = null

  if (backend) {
    await backend.prepare?.()
    // Seed the remote echo check with this device's local rows: an echo of a
    // record that was only ever uploaded from here still has its parent here.
    const sessionKeys = buildSessionKeyChain(db)
    const ownWireIds = new Set(buildLocalSnapshot(db, deviceInstanceId).records.keys())
    remote = await planRemoteRepair(backend, { deviceInstanceId, allNamespaces: options.allNamespaces, sessionKeys, ownWireIds })
  }

  const local = planLocalRepair(db, deviceInstanceId, remote?.allRecords, remote?.presentOwners)
  const report: RepairReport = { deviceInstanceId, local, remote, applied: false }

  if (!options.apply) return report

  applyLocalRepair(db, local)
  if (backend && remote) {
    const result = await applyRemoteRepair(backend, remote, deviceInstanceId)
    const flushed = remote.files.length > 0 ? (await backend.flush?.()) ?? false : false
    report.remoteResult = { ...result, flushed }
  }
  report.applied = true
  return report
}
