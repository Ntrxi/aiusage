import type Database from 'better-sqlite3'

/**
 * Per-target provenance of pulled records.
 *
 * `sync_record_claims` records, for every sync target, which records of which
 * foreign device namespace this device has mirrored from that target. A pulled
 * row (`synced_records` + its merged `records` copy) is only ever deleted when
 * *no* target claims it any more: reconciling target A replaces A's claims for
 * a namespace, and rows that target B still claims survive.
 *
 * A row no target claims is *unresolved* (`synced_records.unclaimed_since`
 * is set): it was pulled before claims existed (migration v14) or read from a
 * namespace no target has verified since. `sync_namespace_verdicts` records,
 * per target and namespace owner, when the target last judged that namespace
 * reliably. An unresolved row is deleted only once every target this device
 * knows has judged its namespace after the row became unresolved — see
 * `pruneUnresolvedSyncedRecords` and `docs/sync-namespaces.md`.
 *
 * "When" is measured on the *sync clock*, not the wall clock: every sync run
 * takes a tick one greater than any tick recorded so far (`nextSyncTick`),
 * stamps the rows it upserts unresolved with it, and records its verdicts
 * under it. A verdict settles a row only when its tick is strictly greater
 * than the row's, so the sync that upserted a row can never be the one that
 * judges it absent, and two syncs can never be confused for one however
 * fast they run. Rows that predate the table carry tick 0.
 */

/** The tick of the sync that is starting: one more than any tick recorded so far. */
export function nextSyncTick(db: Database.Database): number {
  const row = db.prepare(`
    SELECT MAX(t) AS t FROM (
      SELECT MAX(judged_at) AS t FROM sync_namespace_verdicts
      UNION ALL
      SELECT MAX(unclaimed_since) AS t FROM synced_records
    )
  `).get() as { t: number | null }
  return (row.t ?? 0) + 1
}

/**
 * Verdict key for rows whose namespace owner is not a concrete device id
 * (legacy lines stamped `'unknown'` or empty). Such rows can be hiding in any
 * namespace of a target, so the target's verdict on them is "every namespace
 * on this target was read reliably".
 */
export const UNKNOWN_NAMESPACE_VERDICT = 'unknown'

export interface NamespaceClaims {
  owner: string
  recordIds: Set<string>
}

/** Foreign namespaces that have at least one claim on `target`. */
export function getClaimedOwners(db: Database.Database, target: string): string[] {
  const rows = db.prepare(`
    SELECT DISTINCT device_instance_id FROM sync_record_claims WHERE target = ?
  `).all(target) as Array<{ device_instance_id: string }>
  return rows.map(r => r.device_instance_id)
}

/** Record ids claimed for `owner` on `target`. */
export function getClaimedRecordIds(db: Database.Database, target: string, owner: string): Set<string> {
  const rows = db.prepare(`
    SELECT record_id FROM sync_record_claims WHERE target = ? AND device_instance_id = ?
  `).all(target, owner) as Array<{ record_id: string }>
  return new Set(rows.map(r => r.record_id))
}

/** Every target that currently claims `recordId`. */
export function getClaimingTargets(db: Database.Database, recordId: string): string[] {
  const rows = db.prepare(`SELECT DISTINCT target FROM sync_record_claims WHERE record_id = ?`).all(recordId) as Array<{ target: string }>
  return rows.map(r => r.target)
}

/**
 * Replace the claims `target` holds for `owner`'s namespace with exactly
 * `recordIds`. Must run inside the caller's transaction when combined with
 * pruning (see `reconcileSyncedNamespace`).
 */
export function replaceNamespaceClaims(db: Database.Database, target: string, owner: string, recordIds: Iterable<string>): void {
  db.prepare(`DELETE FROM sync_record_claims WHERE target = ? AND device_instance_id = ?`).run(target, owner)
  const insert = db.prepare(`
    INSERT OR IGNORE INTO sync_record_claims (target, device_instance_id, record_id) VALUES (?, ?, ?)
  `)
  // A claimed row has a known provenance: it is no longer unresolved.
  const resolve = db.prepare(`UPDATE synced_records SET unclaimed_since = NULL WHERE id = ? AND unclaimed_since IS NOT NULL`)
  for (const id of recordIds) {
    insert.run(target, owner, id)
    resolve.run(id)
  }
}

/**
 * Record that `target` judged `owner`'s namespace reliably at sync tick
 * `judgedAt`: it verified the namespace snapshot, found it authoritatively
 * empty, or found it absent. Rows of `owner` that `target` did not claim in
 * that judgement were not on `target` at that time.
 */
export function recordNamespaceVerdict(db: Database.Database, target: string, owner: string, judgedAt: number): void {
  db.prepare(`
    INSERT INTO sync_namespace_verdicts (target, device_instance_id, judged_at) VALUES (?, ?, ?)
    ON CONFLICT(target, device_instance_id) DO UPDATE SET judged_at = MAX(judged_at, excluded.judged_at)
  `).run(target, owner, judgedAt)
}

/** The sync tick at which each target last judged `owner`'s namespace, keyed by target. */
export function getNamespaceVerdicts(db: Database.Database, owner: string): Map<string, number> {
  const rows = db.prepare(`SELECT target, judged_at FROM sync_namespace_verdicts WHERE device_instance_id = ?`).all(owner) as Array<{ target: string; judged_at: number }>
  return new Map(rows.map(r => [r.target, r.judged_at]))
}

/**
 * Remove claims whose record no longer exists in `synced_records`. Every code
 * path that deletes mirrored rows outside reconciliation (repair, retention
 * clean-up) calls this so a claim can never outlive its row. Returns the
 * number of claims removed.
 */
export function dropDanglingClaims(db: Database.Database): number {
  return db.prepare(`DELETE FROM sync_record_claims WHERE record_id NOT IN (SELECT id FROM synced_records)`).run().changes
}

/** True when `target` currently claims `recordId`. */
export function hasClaim(db: Database.Database, target: string, recordId: string): boolean {
  return db.prepare(`SELECT 1 FROM sync_record_claims WHERE target = ? AND record_id = ? LIMIT 1`).get(target, recordId) !== undefined
}

/** Drop a single claim. Returns true when no target claims the record any more. */
export function releaseClaim(db: Database.Database, target: string, recordId: string): boolean {
  db.prepare(`DELETE FROM sync_record_claims WHERE target = ? AND record_id = ?`).run(target, recordId)
  const remaining = db.prepare(`SELECT 1 FROM sync_record_claims WHERE record_id = ? LIMIT 1`).get(recordId)
  return remaining === undefined
}

/**
 * Wire ids this device published under `target` in the past and will never
 * publish again (see migration v14). File-based backends drop them implicitly
 * when the namespace snapshot is rewritten; the cloud backend needs explicit
 * tombstones.
 */
export function getRetiredWireIds(db: Database.Database, target: string): string[] {
  const rows = db.prepare(`SELECT wire_id FROM sync_retired_wire_ids WHERE target = ?`).all(target) as Array<{ wire_id: string }>
  return rows.map(r => r.wire_id)
}

export function clearRetiredWireIds(db: Database.Database, target: string, wireIds?: string[]): void {
  if (wireIds === undefined) {
    db.prepare(`DELETE FROM sync_retired_wire_ids WHERE target = ?`).run(target)
    return
  }
  const del = db.prepare(`DELETE FROM sync_retired_wire_ids WHERE target = ? AND wire_id = ?`)
  db.transaction(() => {
    for (const id of wireIds) del.run(target, id)
  })()
}
