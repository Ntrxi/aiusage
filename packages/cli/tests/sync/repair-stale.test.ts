import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { generateRecordId } from '@aiusage/core'
import type { StatsRecord, SyncRecord } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord } from '../../src/db/records.js'
import { SyncOrchestrator, buildLocalSnapshot } from '../../src/sync/index.js'
import { mapStatsRecordToSyncRecord } from '../../src/sync/mapper.js'
import { repairSyncContamination, planRemoteRepair } from '../../src/sync/repair.js'
import { FakeSyncBackend } from './helpers/fake-backend.js'

// `sync --repair` must also see the two failure classes that authoritative
// namespaces fix going forward: lines left behind in this device's namespace
// that no local record produces any more (stale), and local records that map
// to the same wire id (collision), plus duplicated ids inside a namespace.

const A = 'device-a'
const B = 'device-b'
const DAY = Date.UTC(2026, 8, 6, 12, 0, 0)

function local(n: number, overrides: Partial<StatsRecord> = {}): StatsRecord {
  return {
    id: generateRecordId(A, `msg_${n}`, 0),
    ts: DAY + n * 1000,
    ingestedAt: DAY,
    updatedAt: DAY,
    lineOffset: 100 * (n + 1),
    tool: 'claude-code',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    inputTokens: 100 + n,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    cost: 0.001,
    costSource: 'pricing',
    sessionId: 'sess-a',
    sourceFile: 'C:\\Users\\alice\\.claude\\projects\\p\\s.jsonl',
    cwd: 'C:\\proj',
    device: 'G14',
    deviceInstanceId: A,
    platform: 'win32',
    ...overrides,
  }
}

const ndjson = (records: SyncRecord[]) => records.map(r => JSON.stringify(r)).join('\n') + '\n'

describe('sync --repair: stale lines, duplicates and wire-id collisions', () => {
  let backend: FakeSyncBackend
  let db: Database.Database
  let wires: SyncRecord[]

  beforeEach(() => {
    backend = new FakeSyncBackend()
    db = new Database(':memory:')
    initializeDatabase(db)
    const locals = [0, 1, 2].map(n => local(n))
    for (const r of locals) insertRecord(db, r)
    wires = locals.map(mapStatsRecordToSyncRecord)
  })

  it('reports and removes lines in the own namespace that no local record produces', async () => {
    const stale = { ...wires[0], id: 'old-id-from-before-rebuild' }
    backend.files.set(`${A}/2026/09/06.ndjson`, ndjson([...wires, stale]))
    // Another device's namespace is never judged for staleness.
    backend.files.set(`${B}/2026/09/06.ndjson`, ndjson([{ ...wires[1], id: 'b-1', deviceInstanceId: B, sessionKey: 'zz' }]))

    const dry = await repairSyncContamination(db, { deviceInstanceId: A, backend, allNamespaces: true })
    const nsA = dry.remote!.namespaces.find(n => n.owner === A)!
    const nsB = dry.remote!.namespaces.find(n => n.owner === B)!
    expect(nsA).toMatchObject({ lines: 4, staleLines: 1, duplicateLines: 0, foreignLines: 0, echoLines: 0 })
    expect(nsB).toMatchObject({ lines: 1, staleLines: 0 })
    expect(dry.remote!.files.map(f => f.path)).toEqual([`${A}/2026/09/06.ndjson`])
    expect(backend.linesUnder(A)).toHaveLength(4)

    const applied = await repairSyncContamination(db, { deviceInstanceId: A, backend, apply: true })
    expect(applied.remoteResult).toMatchObject({ rewritten: 1, deleted: 0, flushed: true })
    expect(backend.linesUnder(A).map(l => l.id).sort()).toEqual(wires.map(w => w.id).sort())
    expect(backend.linesUnder(B)).toHaveLength(1)

    const again = await repairSyncContamination(db, { deviceInstanceId: A, backend })
    expect(again.remote!.files).toEqual([])
    const sync = await new SyncOrchestrator(db, backend, { deviceInstanceId: A, target: 't', consentVerified: true }).sync()
    expect(sync).toMatchObject({ status: 'ok', retiredCount: 0, writtenFiles: 0 })
  })

  it('keeps only the newest copy of an id duplicated across day files of one namespace', async () => {
    const older = { ...wires[0], updatedAt: wires[0].updatedAt - 5 }
    backend.files.set(`${A}/2026/09/06.ndjson`, ndjson(wires))
    backend.files.set(`${A}/2026/09/05.ndjson`, ndjson([older]))

    const plan = await planRemoteRepair(backend, { deviceInstanceId: A, ownWireIds: new Set(wires.map(w => w.id)) })
    expect(plan.namespaces[0]).toMatchObject({ owner: A, duplicateLines: 1, staleLines: 0 })
    const stalePlan = plan.files.find(f => f.path === `${A}/2026/09/05.ndjson`)!
    expect(stalePlan).toMatchObject({ duplicateLines: 1, keptRecords: [] })
    expect(plan.files.some(f => f.path === `${A}/2026/09/06.ndjson`)).toBe(false)
  })

  it('reports local wire-id collisions without deleting anything', async () => {
    // Two rows that the (fixed) mapper would still collapse: identical wire key.
    const dupA = local(7, { id: 'colliding-a', updatedAt: DAY + 1 })
    const dupB = local(7, { id: 'colliding-b', updatedAt: DAY + 2 })
    insertRecord(db, dupA)
    insertRecord(db, dupB)
    const snapshot = buildLocalSnapshot(db, A)
    expect(snapshot.collisions).toEqual([{ wireId: mapStatsRecordToSyncRecord(dupA).id, recordIds: ['colliding-a'] }])
    expect(snapshot.records.size).toBe(4)

    const report = await repairSyncContamination(db, { deviceInstanceId: A, backend, apply: true })
    expect(report.local.wireIdCollisions).toEqual(snapshot.collisions)
    expect(db.prepare(`SELECT COUNT(*) AS n FROM records`).get()).toEqual({ n: 5 })

    const sync = await new SyncOrchestrator(db, backend, { deviceInstanceId: A, target: 't', consentVerified: true }).sync()
    expect(sync.collisionCount).toBe(1)
    // The most recently updated record wins the slot.
    expect(backend.linesUnder(A).find(l => l.id === mapStatsRecordToSyncRecord(dupB).id)?.updatedAt).toBe(DAY + 2)
  })
})
