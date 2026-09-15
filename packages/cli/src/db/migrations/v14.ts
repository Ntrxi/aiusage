import type Database from 'better-sqlite3'
import { generateSyncRecordId } from '@aiusage/core'

/**
 * Authoritative sync namespaces.
 *
 * 1. `sync_namespaces` remembers, per sync target, which foreign device
 *    namespaces this device has pulled from. Pull reconciles `synced_records`
 *    against the namespaces that exist remotely *and* the ones previously seen
 *    on the same target, so a namespace that disappears from its target is
 *    pruned locally while rows that came from a different target are left
 *    alone.
 *
 * 2. `sync_retired_wire_ids` holds wire ids this device has published under a
 *    target but will never publish again. Antigravity and Trae records used to
 *    be uploaded under `sha256(device, sourceFile, lineOffset)`, which is not
 *    unique for those tools (several usage events share one generation index;
 *    every Trae session shares offset 0), silently collapsing records. They now
 *    travel under their parser-generated `record.id`. File-based backends
 *    replace the whole namespace on the next sync, so nothing else is needed
 *    there; the cloud backend is upsert-only, so the old ids are pushed as
 *    tombstones and then forgotten. The affected `sync_record_state` rows are
 *    dropped so the records are re-published under their new ids.
 */
const REKEYED_TOOLS = ['antigravity', 'trae'] as const

export function migrateV14(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_namespaces (
      target             TEXT NOT NULL,
      device_instance_id TEXT NOT NULL,
      last_seen_at       INTEGER NOT NULL,
      PRIMARY KEY (target, device_instance_id)
    );

    CREATE TABLE IF NOT EXISTS sync_retired_wire_ids (
      target  TEXT NOT NULL,
      wire_id TEXT NOT NULL,
      PRIMARY KEY (target, wire_id)
    );
  `)

  const placeholders = REKEYED_TOOLS.map(() => '?').join(', ')
  const rows = db.prepare(`
    SELECT s.target, r.device_instance_id, r.source_file, r.line_offset
    FROM sync_record_state s
    JOIN records r ON r.id = s.record_id
    WHERE r.origin = 'local' AND r.tool IN (${placeholders})
  `).all(...REKEYED_TOOLS) as Array<{ target: string; device_instance_id: string; source_file: string; line_offset: number }>

  if (rows.length > 0) {
    const insert = db.prepare(`INSERT OR IGNORE INTO sync_retired_wire_ids (target, wire_id) VALUES (?, ?)`)
    for (const row of rows) {
      insert.run(row.target, generateSyncRecordId(row.device_instance_id, row.source_file, row.line_offset))
    }
    db.prepare(`
      DELETE FROM sync_record_state
      WHERE record_id IN (SELECT id FROM records WHERE origin = 'local' AND tool IN (${placeholders}))
    `).run(...REKEYED_TOOLS)
    db.prepare(`
      UPDATE records SET synced_at = NULL
      WHERE origin = 'local' AND tool IN (${placeholders})
    `).run(...REKEYED_TOOLS)
  }

  db.prepare('INSERT INTO schema_version (version) VALUES (14)').run()
}
