import type Database from 'better-sqlite3'

/**
 * Per-target bookkeeping for authoritative namespace reconciliation.
 *
 * `sync_namespaces` lists the foreign device namespaces this device has seen
 * on a given sync target. A namespace that was seen before but is absent from
 * the target now has been deleted remotely, so its rows are pruned; rows that
 * arrived through a *different* target are never touched by this one.
 */
export function getSeenNamespaces(db: Database.Database, target: string): string[] {
  const rows = db.prepare(`SELECT device_instance_id FROM sync_namespaces WHERE target = ?`).all(target) as Array<{ device_instance_id: string }>
  return rows.map(r => r.device_instance_id)
}

export function recordSeenNamespaces(db: Database.Database, target: string, owners: Iterable<string>, now = Date.now()): void {
  const upsert = db.prepare(`
    INSERT INTO sync_namespaces (target, device_instance_id, last_seen_at) VALUES (?, ?, ?)
    ON CONFLICT(target, device_instance_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
  `)
  db.transaction(() => {
    for (const owner of owners) upsert.run(target, owner, now)
  })()
}

export function forgetNamespace(db: Database.Database, target: string, owner: string): void {
  db.prepare(`DELETE FROM sync_namespaces WHERE target = ? AND device_instance_id = ?`).run(target, owner)
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
