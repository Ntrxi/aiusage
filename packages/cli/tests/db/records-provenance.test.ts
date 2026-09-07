import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { StatsRecord } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord, getRecordById, getUnsyncedRecords, markRecordsSynced, repairRecordProvenance } from '../../src/db/records.js'

function rec(overrides: Partial<StatsRecord>): StatsRecord {
  return {
    id: 'r',
    ts: 1000,
    ingestedAt: 1000,
    updatedAt: 1000,
    lineOffset: 10,
    tool: 'claude-code',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    cost: 0,
    costSource: 'pricing',
    sessionId: 's',
    sourceFile: 'C:\\Users\\alice\\.claude\\projects\\p\\s.jsonl',
    device: 'G14',
    deviceInstanceId: 'device-a',
    ...overrides,
  }
}

describe('records provenance', () => {
  let db: Database.Database
  beforeEach(() => { db = new Database(':memory:'); initializeDatabase(db) })
  afterEach(() => db.close())

  it('defaults origin to local and round-trips it', () => {
    insertRecord(db, rec({ id: 'l' }))
    insertRecord(db, rec({ id: 's', origin: 'synced' }))
    expect(getRecordById(db, 'l')?.origin).toBe('local')
    expect(getRecordById(db, 's')?.origin).toBe('synced')
  })

  it('never returns synced rows as unsynced, whatever their source_file', () => {
    insertRecord(db, rec({ id: 'pulled', origin: 'synced', deviceInstanceId: 'device-b' }))
    insertRecord(db, rec({ id: 'pulled-placeholder', origin: 'synced', sourceFile: 'synced/device-b', deviceInstanceId: 'device-b' }))
    insertRecord(db, rec({ id: 'mine' }))
    expect(getUnsyncedRecords(db).map(r => r.id)).toEqual(['mine'])
    expect(getUnsyncedRecords(db, 'github:x/y').map(r => r.id)).toEqual(['mine'])
    expect(getUnsyncedRecords(db, 'github:x/y', 'device-a').map(r => r.id)).toEqual(['mine'])
  })

  it('excludes rows stamped with another device id when the current device is known', () => {
    insertRecord(db, rec({ id: 'foreign', deviceInstanceId: 'device-b' })) // origin local but not ours
    insertRecord(db, rec({ id: 'pre-init', deviceInstanceId: 'unknown' }))
    insertRecord(db, rec({ id: 'mine' }))
    expect(getUnsyncedRecords(db, 'github:x/y', 'device-a').map(r => r.id).sort()).toEqual(['mine', 'pre-init'])
    // Without a device id the provenance flag alone decides (legacy callers).
    expect(getUnsyncedRecords(db, 'github:x/y').map(r => r.id).sort()).toEqual(['foreign', 'mine', 'pre-init'])
  })

  it('repairRecordProvenance re-flags foreign-device rows and drops their sync bookkeeping', () => {
    insertRecord(db, rec({ id: 'foreign', deviceInstanceId: 'device-b' }))
    insertRecord(db, rec({ id: 'mine' }))
    insertRecord(db, rec({ id: 'pre-init', deviceInstanceId: 'unknown' }))
    markRecordsSynced(db, ['foreign', 'mine'], 2000, 'github:x/y')

    expect(repairRecordProvenance(db, 'device-a')).toBe(1)
    expect(repairRecordProvenance(db, 'device-a')).toBe(0) // idempotent

    expect(getRecordById(db, 'foreign')?.origin).toBe('synced')
    expect(getRecordById(db, 'mine')?.origin).toBe('local')
    expect(getRecordById(db, 'pre-init')?.origin).toBe('local')
    expect(db.prepare('SELECT record_id FROM sync_record_state ORDER BY record_id').all()).toEqual([{ record_id: 'mine' }])
  })

  it('re-parsing a row keeps it local (INSERT OR REPLACE writes origin explicitly)', () => {
    insertRecord(db, rec({ id: 'x', origin: 'synced' }))
    insertRecord(db, rec({ id: 'x', updatedAt: 2000 }))
    expect(getRecordById(db, 'x')?.origin).toBe('local')
  })
})
