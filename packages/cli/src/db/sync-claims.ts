import type Database from 'better-sqlite3'

/**
 * Per-target provenance of pulled records.
 *
 * `sync_record_claims` records, for every sync target, which records of which
 * foreign device namespace this device has mirrored from that target. A pulled
 * row (`synced_records` + its merged `records` copy) is only ever deleted when
 * *no* target claims it any more: reconciling target A replaces A's claims for
 * a namespace, and rows that target B still claims survive. Rows that predate
 * the table (pulled before migration v14) carry no claim until the namespace
 * they came from is reconciled once; see `docs/sync-namespaces.md`.
 */

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
  for (const id of recordIds) insert.run(target, owner, id)
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
