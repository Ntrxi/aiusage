import type Database from 'better-sqlite3'

/**
 * Cross-device provenance repair (explicit `records.origin`).
 *
 * Records pulled from other devices are copied from `synced_records` into
 * `records` so local queries can see them. Historically the only marker that a
 * row in `records` was such a copy was `source_file LIKE 'synced/%'`. Once the
 * wire format started carrying the real `source_file` (needed for cross-device
 * project stats), that marker disappeared and pulled rows became
 * indistinguishable from locally parsed ones: they were re-uploaded under the
 * *pulling* device's sync namespace (with colliding ids, because merged rows
 * have `line_offset = 0`) and double-counted in local summaries.
 *
 * This migration adds an explicit `origin` column ('local' | 'synced') and
 * back-fills it deterministically. A row is classified as `synced` when:
 *
 *   1. it still carries the legacy `synced/<device>` placeholder source_file, or
 *   2. a `synced_records` row with the same id exists whose `session_key`
 *      equals the row's `session_id`.
 *
 * Rule 2 is the fingerprint of `mergeSyncedRecordsIntoRecords`: it is the only
 * writer that stores the 24-hex `session_key` hash in `records.session_id`.
 * Parsers store the tool's real session id, and no tool session id can equal
 * `sha256(device + '\0' + sessionId)[0:24]` of another session (that would be a
 * hash pre-image). Local rows that were later re-parsed keep their real
 * session id and therefore stay `local`, so no legitimate local usage is hidden.
 *
 * `sync_record_state` rows that were created when those pulled rows were
 * wrongly uploaded are removed so they can never be mistaken for local sync
 * bookkeeping. Nothing else is deleted here — see `aiusage sync --repair` for
 * the opt-in cleanup of echoed rows and contaminated remote namespaces.
 */
export function migrateV13(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(records)').all() as Array<{ name: string }>
  if (!columns.some(c => c.name === 'origin')) {
    db.exec(`ALTER TABLE records ADD COLUMN origin TEXT NOT NULL DEFAULT 'local'`)
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_records_origin ON records(origin)`)

  db.exec(`
    UPDATE records
    SET origin = 'synced'
    WHERE origin = 'local'
      AND (
        source_file LIKE 'synced/%'
        OR EXISTS (
          SELECT 1 FROM synced_records s
          WHERE s.id = records.id AND s.session_key = records.session_id
        )
      )
  `)

  db.exec(`
    DELETE FROM sync_record_state
    WHERE record_id IN (SELECT id FROM records WHERE origin = 'synced')
  `)

  db.prepare('INSERT INTO schema_version (version) VALUES (13)').run()
}
