import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { generateRecordId, generateSessionKey, generateSyncRecordId } from '@aiusage/core'
import type { StatsRecord } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord, getUnsyncedRecords, getRecordById } from '../../src/db/records.js'
import { insertSyncedRecord } from '../../src/db/synced-records.js'
import { SyncOrchestrator } from '../../src/sync/index.js'
import { generateSummary } from '../../src/commands/summary.js'
import { FakeSyncBackend } from './helpers/fake-backend.js'

// Regression for the cross-device GitHub sync bug: records pulled from device A
// kept their real `source_file` (e.g. C:\Users\alice\.claude\...), so device B's
// `source_file NOT LIKE 'synced/%'` heuristic treated them as local and
// re-uploaded them under B's namespace with `line_offset = 0` (colliding ids).

const DEVICE_A = '0a1b2c3d-1111-4aaa-8aaa-aaaaaaaaaaaa' // G14
const DEVICE_B = '0a1b2c3d-2222-4bbb-8bbb-bbbbbbbbbbbb' // MSI
const TARGET = 'github:example/aiusage-data'
const SOURCE_FILE_A = 'C:\\Users\\alice\\.claude\\projects\\C--Users-alice\\session.jsonl'
const CWD_A = 'C:\\Users\\alice\\Documents\\GitHub\\aiusage'
const SESSION_A = '9f8e7d6c-3333-4ccc-8ccc-cccccccccccc'
const DAY = Date.UTC(2026, 8, 6, 12, 0, 0)

/** Build a record the way the Claude Code parser does (id from message id, offset 0 in the hash). */
function claudeRecord(deviceInstanceId: string, device: string, sourceFile: string, cwd: string, sessionId: string, n: number): StatsRecord {
  const messageId = `msg_${deviceInstanceId.slice(0, 4)}_${n}`
  return {
    id: generateRecordId(deviceInstanceId, messageId, 0),
    ts: DAY + n * 60_000,
    ingestedAt: DAY + 1_000_000,
    updatedAt: DAY + 1_000_000,
    lineOffset: 100 + n * 1234,
    tool: 'claude-code',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    inputTokens: 1000 + n,
    outputTokens: 500 + n,
    cacheReadTokens: 0,
    cacheWriteTokens: 200,
    thinkingTokens: 0,
    cost: 0.01 * (n + 1),
    costSource: 'pricing',
    sessionId,
    sourceFile,
    cwd,
    device,
    deviceInstanceId,
    platform: 'win32',
  }
}

function newDb(): Database.Database {
  const db = new Database(':memory:')
  initializeDatabase(db)
  return db
}

function orchestrator(db: Database.Database, backend: FakeSyncBackend, deviceInstanceId: string) {
  return new SyncOrchestrator(db, backend, { deviceInstanceId, target: TARGET, consentVerified: true })
}

function summaryOf(db: Database.Database, deviceInstanceId: string) {
  const s = generateSummary(db, { currentDeviceInstanceId: deviceInstanceId })
  return { totalTokens: s.totalTokens, totalCost: Number(s.totalCost.toFixed(9)), recordCount: s.recordCount, byTool: s.byTool }
}

describe('cross-device provenance (A → B → A)', () => {
  let backend: FakeSyncBackend
  let dbA: Database.Database
  let dbB: Database.Database
  let recordsA: StatsRecord[]

  beforeEach(() => {
    backend = new FakeSyncBackend()
    dbA = newDb()
    dbB = newDb()
    // Device A: multiple Claude Code records from ONE source file.
    recordsA = [0, 1, 2, 3].map(n => claudeRecord(DEVICE_A, 'G14', SOURCE_FILE_A, CWD_A, SESSION_A, n))
    for (const r of recordsA) insertRecord(dbA, r)
  })

  it('never re-uploads pulled records and keeps every id distinct', async () => {
    // 1–2. A uploads.
    const a1 = await orchestrator(dbA, backend, DEVICE_A).sync()
    expect(a1.status).toBe('ok')
    expect(a1.uploadedCount).toBe(4)
    const uploadedIdsA = backend.linesUnder(DEVICE_A).map(l => l.id)
    expect(new Set(uploadedIdsA).size).toBe(4)
    expect(uploadedIdsA.sort()).toEqual(recordsA.map(r => generateSyncRecordId(DEVICE_A, SOURCE_FILE_A, r.lineOffset)).sort())

    // 3–4. B pulls and merges.
    const b1 = await orchestrator(dbB, backend, DEVICE_B).sync()
    expect(b1.status).toBe('ok')
    expect(b1.pulledCount).toBe(4)
    expect(b1.mergedCount).toBe(4)
    expect(b1.uploadedCount).toBe(0)

    // Pulled rows are visible locally, flagged as synced, with source_file and cwd intact.
    const mergedRows = dbB.prepare(`SELECT id, origin, source_file, cwd, device_instance_id, line_offset FROM records`).all() as any[]
    expect(mergedRows).toHaveLength(4)
    for (const row of mergedRows) {
      expect(row.origin).toBe('synced')
      expect(row.source_file).toBe(SOURCE_FILE_A)
      expect(row.cwd).toBe(CWD_A)
      expect(row.device_instance_id).toBe(DEVICE_A)
      expect(row.line_offset).toBe(0) // merged rows have no byte offset…
    }
    expect(new Set(mergedRows.map(r => r.id)).size).toBe(4) // …but their ids are still distinct.
    const syncedRows = dbB.prepare(`SELECT source_file, cwd FROM synced_records`).all() as any[]
    expect(syncedRows.every(r => r.source_file === SOURCE_FILE_A && r.cwd === CWD_A)).toBe(true)

    // Device A's records are NOT local on device B.
    expect(getUnsyncedRecords(dbB, TARGET, DEVICE_B)).toHaveLength(0)
    expect(getUnsyncedRecords(dbB, TARGET)).toHaveLength(0)

    // 5. B now has its own usage and syncs.
    const recordB = claudeRecord(DEVICE_B, 'MSI', 'C:\\Users\\msi\\.claude\\projects\\p\\s.jsonl', 'C:\\Users\\msi\\proj', 'b-session', 0)
    insertRecord(dbB, recordB)
    const b2 = await orchestrator(dbB, backend, DEVICE_B).sync()
    expect(b2.status).toBe('ok')
    expect(b2.uploadedCount).toBe(1)

    // 6. B's namespace contains only B's own record; A's records were not re-uploaded there.
    const linesB = backend.linesUnder(DEVICE_B)
    expect(linesB).toHaveLength(1)
    expect(linesB[0].deviceInstanceId).toBe(DEVICE_B)
    expect(linesB.some(l => l.deviceInstanceId === DEVICE_A)).toBe(false)
    expect(backend.linesUnder(DEVICE_A)).toHaveLength(4)

    // A pulls B's record; A's own records never come back as "synced".
    const a2 = await orchestrator(dbA, backend, DEVICE_A).sync()
    expect(a2.status).toBe('ok')
    expect(a2.pulledCount).toBe(1)
    expect(a2.ignoredCount).toBe(0)
    expect(dbA.prepare(`SELECT COUNT(*) AS n FROM synced_records WHERE device_instance_id = ?`).get(DEVICE_A)).toEqual({ n: 0 })
    expect(dbA.prepare(`SELECT COUNT(*) AS n FROM records WHERE origin = 'local'`).get()).toEqual({ n: 4 })
    expect(dbA.prepare(`SELECT COUNT(*) AS n FROM records WHERE origin = 'synced'`).get()).toEqual({ n: 1 })

    // All ids across the whole system remain distinct.
    const allRemoteIds = [...backend.linesUnder(DEVICE_A), ...backend.linesUnder(DEVICE_B)].map(l => l.id)
    expect(new Set(allRemoteIds).size).toBe(5)

    // Repeated A → B → A syncs are idempotent: no further writes, no further pulls.
    const snapshot = new Map(backend.files)
    const writesBefore = backend.writes.length
    for (const [db, dev] of [[dbA, DEVICE_A], [dbB, DEVICE_B], [dbA, DEVICE_A], [dbB, DEVICE_B]] as const) {
      const r = await orchestrator(db, backend, dev).sync()
      expect(r.status).toBe('ok')
      expect(r.uploadedCount).toBe(0)
      expect(r.pulledCount).toBe(0)
      expect(r.mergedCount).toBe(0)
    }
    expect(backend.writes.length).toBe(writesBefore)
    expect(new Map(backend.files)).toEqual(snapshot)

    // Summary totals are identical on both machines and count each record exactly once.
    const sumA = summaryOf(dbA, DEVICE_A)
    const sumB = summaryOf(dbB, DEVICE_B)
    expect(sumA).toEqual(sumB)
    expect(sumA.recordCount).toBe(5)
    const expectedTokens = [...recordsA, recordB].reduce((n, r) => n + r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.thinkingTokens, 0)
    expect(sumA.totalTokens).toBe(expectedTokens)

    // Per-device views agree as well.
    expect(generateSummary(dbB, { currentDeviceInstanceId: DEVICE_B, device: DEVICE_A }).recordCount).toBe(4)
    expect(generateSummary(dbA, { currentDeviceInstanceId: DEVICE_A, device: DEVICE_A }).recordCount).toBe(4)
    expect(generateSummary(dbA, { currentDeviceInstanceId: DEVICE_A, device: DEVICE_B }).recordCount).toBe(1)
  })

  it('ignores remote lines that do not belong to the namespace they sit in', async () => {
    await orchestrator(dbA, backend, DEVICE_A).sync()
    // Simulate a contaminated namespace left behind by the old bug: A's records
    // (with colliding ids) under B's directory, plus an echo of B's own record.
    const echoOfA = {
      ...JSON.parse(backend.files.get(`${DEVICE_A}/2026/09/06.ndjson`)!.split('\n')[0]),
      id: generateSyncRecordId(DEVICE_A, SOURCE_FILE_A, 0),
    }
    backend.files.set(`${DEVICE_B}/2026/09/06.ndjson`, JSON.stringify(echoOfA) + '\n')

    // A third device pulls: the foreign line is ignored, A's real lines are accepted.
    const dbC = newDb()
    const c = await orchestrator(dbC, backend, 'device-c').sync()
    expect(c.pulledCount).toBe(4)
    expect(c.ignoredCount).toBe(1)
    expect(dbC.prepare(`SELECT COUNT(*) AS n FROM synced_records WHERE id = ?`).get(echoOfA.id)).toEqual({ n: 0 })

    // A pulls: the echo of its own record is ignored, so nothing is double counted.
    const a = await orchestrator(dbA, backend, DEVICE_A).sync()
    expect(a.ignoredCount).toBe(1)
    expect(a.pulledCount).toBe(0)
    expect(summaryOf(dbA, DEVICE_A).recordCount).toBe(4)
  })

  it('repairs a database contaminated by the old heuristic before uploading', async () => {
    // Pre-fix state on B: A's records merged into `records` as if local (real
    // source_file, line_offset 0, session_id = wire session key), plus their
    // synced_records rows. Insert them as `origin: local` to model the old rows.
    const wire = recordsA.map(r => ({
      ...r,
      id: generateSyncRecordId(DEVICE_A, SOURCE_FILE_A, r.lineOffset),
      sessionKey: generateSessionKey(r.device, r.sessionId),
    }))
    for (const w of wire) {
      insertSyncedRecord(dbB, {
        id: w.id, ts: w.ts, tool: w.tool, model: w.model, provider: w.provider,
        inputTokens: w.inputTokens, outputTokens: w.outputTokens, cacheReadTokens: w.cacheReadTokens,
        cacheWriteTokens: w.cacheWriteTokens, thinkingTokens: w.thinkingTokens, cost: w.cost, costSource: w.costSource,
        sessionKey: w.sessionKey, device: w.device, deviceInstanceId: w.deviceInstanceId, platform: w.platform,
        updatedAt: w.updatedAt, sourceFile: w.sourceFile, cwd: w.cwd,
      })
      insertRecord(dbB, { ...w, lineOffset: 0, sessionId: w.sessionKey, origin: 'local' })
    }
    expect(dbB.prepare(`SELECT COUNT(*) AS n FROM records WHERE origin = 'local'`).get()).toEqual({ n: 4 })

    const b = await orchestrator(dbB, backend, DEVICE_B).sync()
    expect(b.status).toBe('ok')
    expect(b.repairedCount).toBe(4)
    expect(b.uploadedCount).toBe(0)
    expect(backend.linesUnder(DEVICE_B)).toHaveLength(0)
    expect(dbB.prepare(`SELECT COUNT(*) AS n FROM records WHERE origin = 'local'`).get()).toEqual({ n: 0 })
    expect(getUnsyncedRecords(dbB, TARGET, DEVICE_B)).toHaveLength(0)
    // Still visible with their project information.
    expect(getRecordById(dbB, wire[0].id)?.cwd).toBe(CWD_A)
  })

  it('does not hide local pre-init records (device_instance_id = unknown)', async () => {
    const legacy = claudeRecord('unknown', 'G14', SOURCE_FILE_A, CWD_A, SESSION_A, 9)
    insertRecord(dbA, legacy)
    const a = await orchestrator(dbA, backend, DEVICE_A).sync()
    expect(a.repairedCount).toBe(0)
    expect(a.uploadedCount).toBe(5)
    expect(backend.linesUnder(DEVICE_A)).toHaveLength(5)
  })
})
