import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { generateRecordId, generateSyncRecordId } from '@aiusage/core'
import type { StatsRecord } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord, markRecordsSynced, getUnsyncedRecords } from '../../src/db/records.js'
import { migrateV14 } from '../../src/db/migrations/v14.js'
import { getRetiredWireIds, getSeenNamespaces, recordSeenNamespaces, forgetNamespace, clearRetiredWireIds } from '../../src/db/sync-namespaces.js'

// v14 adds per-target namespace bookkeeping and records the wire ids that
// Antigravity/Trae records were previously published under, so the cloud
// backend can retract them once they travel under their parser ids.

const DEVICE = 'device-a'
const DB_PATH = 'C:\\Users\\alice\\.gemini\\antigravity\\conversations\\s.db'

function record(overrides: Partial<StatsRecord>): StatsRecord {
  return {
    id: generateRecordId(DEVICE, `antigravity:s:${overrides.lineOffset ?? 0}:${overrides.id ?? ''}`, 0),
    ts: 1000,
    ingestedAt: 1000,
    updatedAt: 1000,
    lineOffset: 0,
    tool: 'antigravity',
    model: 'gemini-2.5-pro',
    provider: 'google',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    cost: 0,
    costSource: 'pricing',
    sessionId: 's',
    sourceFile: DB_PATH,
    device: 'G14',
    deviceInstanceId: DEVICE,
    ...overrides,
  }
}

describe('migration v14', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  it('creates the namespace and retired-id tables', () => {
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map(t => t.name)
    expect(tables).toContain('sync_namespaces')
    expect(tables).toContain('sync_retired_wire_ids')
  })

  it('retires the old generated wire ids of already-synced Antigravity and Trae records and re-queues them', () => {
    const a1 = record({ id: 'a1', lineOffset: 3 })
    const a2 = record({ id: 'a2', lineOffset: 3 }) // shared (sourceFile, lineOffset): one old wire id for both
    const t1 = record({ id: 't1', tool: 'trae', model: 'trae-agent', provider: 'trae', sourceFile: 'C:\\trae.db' })
    const cc = record({ id: 'cc', tool: 'claude-code', model: 'claude-sonnet-4-6', provider: 'anthropic', sourceFile: 'C:\\s.jsonl', lineOffset: 42 })
    const unsyncedAntigravity = record({ id: 'a3', lineOffset: 9 })
    for (const r of [a1, a2, t1, cc, unsyncedAntigravity]) insertRecord(db, r)
    markRecordsSynced(db, [a1.id, a2.id, t1.id, cc.id], 5000, 'github:u/r')
    markRecordsSynced(db, [a1.id], 5000, 'cloud')

    // Re-run the migration body as an upgrade from v13 would.
    db.prepare(`DELETE FROM schema_version WHERE version = 14`).run()
    migrateV14(db)

    expect(getRetiredWireIds(db, 'github:u/r').sort()).toEqual([
      generateSyncRecordId(DEVICE, DB_PATH, 3),
      generateSyncRecordId(DEVICE, 'C:\\trae.db', 0),
    ].sort())
    expect(getRetiredWireIds(db, 'cloud')).toEqual([generateSyncRecordId(DEVICE, DB_PATH, 3)])

    // Re-keyed records are queued for re-publication; the Claude Code row is untouched.
    const pending = getUnsyncedRecords(db, 'github:u/r', DEVICE).map(r => r.id).sort()
    expect(pending).toEqual(['a1', 'a2', 'a3', 't1'].sort())
    expect(db.prepare(`SELECT synced_at FROM records WHERE id = 'cc'`).get()).toEqual({ synced_at: 5000 })

    // Migration is idempotent.
    db.prepare(`DELETE FROM schema_version WHERE version = 14`).run()
    migrateV14(db)
    expect(getRetiredWireIds(db, 'github:u/r')).toHaveLength(2)
  })

  it('does not retire ids for pulled copies of other devices', () => {
    insertRecord(db, record({ id: 'pulled', deviceInstanceId: 'device-b', origin: 'synced' }))
    db.prepare(`INSERT INTO sync_record_state (record_id, target, synced_at) VALUES ('pulled', 'cloud', 1)`).run()
    db.prepare(`DELETE FROM schema_version WHERE version = 14`).run()
    migrateV14(db)
    expect(getRetiredWireIds(db, 'cloud')).toEqual([])
  })

  it('tracks seen namespaces per target', () => {
    recordSeenNamespaces(db, 't1', ['b', 'c'], 10)
    recordSeenNamespaces(db, 't2', ['b'], 10)
    expect(getSeenNamespaces(db, 't1').sort()).toEqual(['b', 'c'])
    expect(getSeenNamespaces(db, 't2')).toEqual(['b'])
    forgetNamespace(db, 't1', 'b')
    expect(getSeenNamespaces(db, 't1')).toEqual(['c'])
    expect(getSeenNamespaces(db, 't2')).toEqual(['b'])
  })

  it('clears retired ids per target, in full or by id', () => {
    db.prepare(`INSERT INTO sync_retired_wire_ids (target, wire_id) VALUES ('t1', 'x'), ('t1', 'y'), ('t2', 'x')`).run()
    clearRetiredWireIds(db, 't1', ['x'])
    expect(getRetiredWireIds(db, 't1')).toEqual(['y'])
    clearRetiredWireIds(db, 't1')
    expect(getRetiredWireIds(db, 't1')).toEqual([])
    expect(getRetiredWireIds(db, 't2')).toEqual(['x'])
  })
})
