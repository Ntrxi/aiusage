import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { generateSessionKey } from '@aiusage/core'
import type { StatsRecord, SyncRecord } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord, getUnsyncedRecords, markRecordsSynced } from '../../src/db/records.js'
import { insertSyncedRecord } from '../../src/db/synced-records.js'
import { migrateV13 } from '../../src/db/migrations/v13.js'

// v13 introduces `records.origin` and back-fills it from the only deterministic
// fingerprint an old merged row carries: its `session_id` equals the
// `session_key` of the `synced_records` row with the same id.

function makeRecord(overrides: Partial<StatsRecord>): StatsRecord {
  return {
    id: 'rec',
    ts: 1000,
    ingestedAt: 1000,
    updatedAt: 1000,
    lineOffset: 0,
    tool: 'claude-code',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    cost: 0,
    costSource: 'pricing',
    sessionId: 'sess-uuid',
    sourceFile: 'C:\\Users\\alice\\.claude\\projects\\p\\s.jsonl',
    cwd: 'C:\\Users\\alice\\proj',
    device: 'G14',
    deviceInstanceId: 'device-a',
    ...overrides,
  }
}

function makeSynced(overrides: Partial<SyncRecord>): SyncRecord {
  return {
    id: 'rec',
    ts: 1000,
    tool: 'claude-code',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    cost: 0,
    costSource: 'pricing',
    sessionKey: generateSessionKey('G14', 'sess-uuid'),
    device: 'G14',
    deviceInstanceId: 'device-a',
    updatedAt: 1000,
    sourceFile: 'C:\\Users\\alice\\.claude\\projects\\p\\s.jsonl',
    cwd: 'C:\\Users\\alice\\proj',
    ...overrides,
  }
}

describe('migration v13 (records.origin provenance)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    // Roll back to the pre-v13 shape: drop the column by recreating the table
    // is heavy, so instead reset every row to 'local' and re-run the backfill.
    db.prepare('DELETE FROM schema_version WHERE version = 13').run()
  })

  afterEach(() => db.close())

  function rerun() {
    db.prepare(`UPDATE records SET origin = 'local'`).run()
    migrateV13(db)
  }

  it('is idempotent on the column and index', () => {
    migrateV13(db)
    db.prepare('DELETE FROM schema_version WHERE version = 13').run()
    expect(() => migrateV13(db)).not.toThrow()
    const cols = (db.prepare('PRAGMA table_info(records)').all() as any[]).filter(c => c.name === 'origin')
    expect(cols).toHaveLength(1)
    expect(cols[0].dflt_value).toBe("'local'")
  })

  it('flags legacy synced/<device> placeholder rows', () => {
    insertRecord(db, makeRecord({ id: 'legacy', sourceFile: 'synced/device-b', deviceInstanceId: 'device-b' }))
    rerun()
    expect(db.prepare('SELECT origin FROM records WHERE id = ?').get('legacy')).toEqual({ origin: 'synced' })
  })

  it('flags rows merged from synced_records with a real source_file (the fingerprint)', () => {
    const key = generateSessionKey('MSI', 'other-sess')
    insertSyncedRecord(db, makeSynced({ id: 'merged', deviceInstanceId: 'device-b', device: 'MSI', sessionKey: key }))
    // Old merge: real source_file, line_offset 0, session_id = session_key, default origin.
    insertRecord(db, makeRecord({ id: 'merged', deviceInstanceId: 'device-b', device: 'MSI', sessionId: key, syncedAt: 2000 }))
    markRecordsSynced(db, ['merged'], 3000, 'github:user/repo') // the bug also "uploaded" it

    rerun()

    expect(db.prepare('SELECT origin, source_file, cwd FROM records WHERE id = ?').get('merged')).toEqual({
      origin: 'synced',
      source_file: 'C:\\Users\\alice\\.claude\\projects\\p\\s.jsonl',
      cwd: 'C:\\Users\\alice\\proj',
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_record_state WHERE record_id = ?').get('merged')).toEqual({ n: 0 })
    expect(getUnsyncedRecords(db, 'github:user/repo', 'device-a').map(r => r.id)).not.toContain('merged')
  })

  it('flags echoes of this device\'s own records that bounced through another device', () => {
    // The echo carries our own device id but was merged from synced_records.
    const echoKey = generateSessionKey('G14', generateSessionKey('G14', 'sess-uuid'))
    insertSyncedRecord(db, makeSynced({ id: 'echo', sessionKey: echoKey }))
    insertRecord(db, makeRecord({ id: 'echo', sessionId: echoKey }))
    // The genuine local record.
    insertRecord(db, makeRecord({ id: 'real', lineOffset: 512 }))

    rerun()

    expect(db.prepare('SELECT origin FROM records WHERE id = ?').get('echo')).toEqual({ origin: 'synced' })
    expect(db.prepare('SELECT origin FROM records WHERE id = ?').get('real')).toEqual({ origin: 'local' })
  })

  it('leaves genuine local rows alone even when a synced row shares the id', () => {
    // Tools that upload record.id verbatim (e.g. hermes) round-trip the same id;
    // if such a record was echoed back, the local row keeps its real session id.
    insertSyncedRecord(db, makeSynced({ id: 'same-id', tool: 'hermes', sessionKey: generateSessionKey('G14', 'hermes-sess') }))
    insertRecord(db, makeRecord({ id: 'same-id', tool: 'hermes', sessionId: 'hermes-sess', sourceFile: '/db.sqlite:session:hermes-sess:t' }))

    rerun()

    expect(db.prepare('SELECT origin FROM records WHERE id = ?').get('same-id')).toEqual({ origin: 'local' })
    expect(getUnsyncedRecords(db, undefined, 'device-a').map(r => r.id)).toContain('same-id')
  })

  it('does not touch ordinary local rows', () => {
    insertRecord(db, makeRecord({ id: 'local-1', lineOffset: 10 }))
    insertRecord(db, makeRecord({ id: 'local-2', lineOffset: 20, deviceInstanceId: 'unknown' }))
    rerun()
    const rows = db.prepare(`SELECT id FROM records WHERE origin = 'local' ORDER BY id`).all()
    expect(rows).toEqual([{ id: 'local-1' }, { id: 'local-2' }])
  })
})
