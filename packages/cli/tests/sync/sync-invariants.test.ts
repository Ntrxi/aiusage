import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { generateRecordId } from '@aiusage/core'
import type { StatsRecord, SyncRecord } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord } from '../../src/db/records.js'
import { insertSyncedRecord, mergeSyncedRecordsIntoRecords } from '../../src/db/synced-records.js'
import { getClaimingTargets, getNamespaceVerdicts } from '../../src/db/sync-claims.js'
import { SyncOrchestrator } from '../../src/sync/index.js'
import { buildManifest, manifestPath, serializeManifest } from '../../src/sync/manifest.js'
import { mapStatsRecordToSyncRecord } from '../../src/sync/mapper.js'
import { repairSyncContamination } from '../../src/sync/repair.js'
import { FakeSyncBackend } from './helpers/fake-backend.js'

// Scenario matrix for the invariants in docs/sync-namespaces.md ("Invariants"
// and "Scenario matrix"). Each describe names the invariants it locks down.
//
//   I1  every pulled row has a provenance: claimed by targets, or unresolved
//   I2  a target only ever releases its own claim
//   I3  a row is deleted only when no target claims it
//   I4  unresolved rows are pruned only after every known target judged them
//   I5  absent / authoritatively empty / unverifiable namespaces are distinct
//   I6  only a verified snapshot can cause deletions
//   I7  interrupted operations never create false absence
//   I8  record versions across targets: newest ever observed wins
//   I9  migration converges once every known target has synced

const X = 'device-x'
const ME = 'device-me'
const GONE = 'device-gone'
const T_A = 'github:org/repo-a'
const T_B = 's3:bucket-b'
const T_C = 'cloud'
const DAY = Date.UTC(2026, 8, 6, 12, 0, 0)

function local(owner: string, n: number, overrides: Partial<StatsRecord> = {}): StatsRecord {
  return {
    id: generateRecordId(owner, `msg_${n}`, 0),
    ts: DAY + n * 60_000,
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
    sessionId: `sess-${owner}`,
    sourceFile: `C:\\Users\\${owner}\\.claude\\projects\\p\\s.jsonl`,
    cwd: 'C:\\proj',
    device: owner.toUpperCase(),
    deviceInstanceId: owner,
    platform: 'win32',
    ...overrides,
  }
}

function newDb(): Database.Database {
  const db = new Database(':memory:')
  initializeDatabase(db)
  return db
}

function sync(db: Database.Database, backend: FakeSyncBackend, deviceInstanceId: string, target: string, knownTargets: string[] = [T_A, T_B]) {
  return new SyncOrchestrator(db, backend, { deviceInstanceId, target, consentVerified: true, knownTargets }).sync()
}

const syncedIds = (db: Database.Database, owner: string) =>
  (db.prepare(`SELECT id FROM synced_records WHERE device_instance_id = ? ORDER BY id`).all(owner) as Array<{ id: string }>).map(r => r.id)
const mergedIds = (db: Database.Database, owner: string) =>
  (db.prepare(`SELECT id FROM records WHERE origin = 'synced' AND device_instance_id = ? ORDER BY id`).all(owner) as Array<{ id: string }>).map(r => r.id)
const tokens = (db: Database.Database, id: string) =>
  (db.prepare(`SELECT input_tokens FROM synced_records WHERE id = ?`).get(id) as { input_tokens: number } | undefined)?.input_tokens
const mergedTokens = (db: Database.Database, id: string) =>
  (db.prepare(`SELECT input_tokens FROM records WHERE id = ?`).get(id) as { input_tokens: number } | undefined)?.input_tokens
const dayFilesOf = (backend: FakeSyncBackend, owner: string) =>
  [...backend.files.keys()].filter(p => p.startsWith(`${owner}/`) && p.endsWith('.ndjson'))

/** The local mirror as a pre-v14 client left it: rows present, no claims, sync tick 0. */
function seedPreV14(db: Database.Database, wires: SyncRecord[]): void {
  for (const w of wires) insertSyncedRecord(db, w)
  db.prepare(`UPDATE synced_records SET unclaimed_since = 0`).run()
  mergeSyncedRecordsIntoRecords(db, ME)
}

describe('I1/I3/I4/I9 — upgrading with several sync targets', () => {
  let dbX: Database.Database
  let dbMe: Database.Database
  let targetA: FakeSyncBackend
  let targetB: FakeSyncBackend
  let wire: SyncRecord[]

  beforeEach(async () => {
    dbX = newDb()
    dbMe = newDb()
    targetA = new FakeSyncBackend()
    targetB = new FakeSyncBackend()
    const records = [0, 1, 2, 3].map(n => local(X, n))
    wire = records.map(mapStatsRecordToSyncRecord)
    for (const r of records.slice(0, 3)) insertRecord(dbX, r)
    await sync(dbX, targetA, X, T_A) // A carries r0 r1 r2
    dbX.prepare(`DELETE FROM records WHERE id = ?`).run(records[0].id)
    insertRecord(dbX, records[3])
    await sync(dbX, targetB, X, T_B) // B carries r1 r2 r3
    // ME mirrored everything it ever saw before claims existed — including a
    // row that no target carries any more.
    seedPreV14(dbMe, [...wire, { ...wire[0], id: 'stale-r9' }])
    expect(dbMe.prepare(`SELECT COUNT(*) AS n FROM sync_record_claims`).get()).toEqual({ n: 0 })
  })

  it('the first target synced after the upgrade never deletes a row the second still carries', async () => {
    const a = await sync(dbMe, targetA, ME, T_A)
    expect(a).toMatchObject({ status: 'ok', prunedCount: 0, skippedNamespaces: 0 })
    expect(syncedIds(dbMe, X)).toEqual([...wire.map(w => w.id), 'stale-r9'].sort())
    for (const n of [0, 1, 2]) expect(getClaimingTargets(dbMe, wire[n].id)).toEqual([T_A])
    expect(getClaimingTargets(dbMe, wire[3].id)).toEqual([])
    expect(getClaimingTargets(dbMe, 'stale-r9')).toEqual([])

    // The second target claims what it carries; only then is the row that
    // neither target carries settled.
    const b = await sync(dbMe, targetB, ME, T_B)
    expect(b).toMatchObject({ status: 'ok', prunedCount: 1, skippedNamespaces: 0 })
    expect(syncedIds(dbMe, X)).toEqual(wire.map(w => w.id).sort())
    expect(mergedIds(dbMe, X)).toEqual(wire.map(w => w.id).sort())
    expect(getClaimingTargets(dbMe, wire[0].id)).toEqual([T_A])
    expect(getClaimingTargets(dbMe, wire[1].id).sort()).toEqual([T_A, T_B].sort())
    expect(getClaimingTargets(dbMe, wire[3].id)).toEqual([T_B])
    expect(dbMe.prepare(`SELECT COUNT(*) AS n FROM synced_records WHERE unclaimed_since IS NOT NULL`).get()).toEqual({ n: 0 })
  })

  it('converges to the same state in the other order', async () => {
    const b = await sync(dbMe, targetB, ME, T_B)
    expect(b).toMatchObject({ prunedCount: 0 })
    expect(syncedIds(dbMe, X)).toHaveLength(5)
    const a = await sync(dbMe, targetA, ME, T_A)
    expect(a).toMatchObject({ prunedCount: 1 })
    expect(syncedIds(dbMe, X)).toEqual(wire.map(w => w.id).sort())
    expect(getClaimingTargets(dbMe, wire[0].id)).toEqual([T_A])
    expect(getClaimingTargets(dbMe, wire[3].id)).toEqual([T_B])
  })

  it('a known target that is never synced keeps unresolved rows, and repair removes the ones this target verified absent', async () => {
    const known = [T_A, T_B, T_C]
    await sync(dbMe, targetA, ME, T_A, known)
    await sync(dbMe, targetB, ME, T_B, known)
    expect(syncedIds(dbMe, X)).toContain('stale-r9')
    const again = await sync(dbMe, targetA, ME, T_A, known)
    expect(again.prunedCount).toBe(0)
    expect(getNamespaceVerdicts(dbMe, X).has(T_C)).toBe(false)

    // X is present on A and A's verified snapshot lacks the row: reported.
    const dry = await repairSyncContamination(dbMe, { deviceInstanceId: ME, target: T_A, backend: targetA })
    expect(dry.local.orphanedSyncedIds).toEqual(['stale-r9'])
    expect(dry.local.orphanedDevices).toEqual([X])
    await repairSyncContamination(dbMe, { deviceInstanceId: ME, target: T_A, backend: targetA, apply: true })
    expect(syncedIds(dbMe, X)).toEqual(wire.map(w => w.id).sort())
    expect(mergedIds(dbMe, X)).toEqual(wire.map(w => w.id).sort())
  })

  it('a verdict recorded before a row became unresolved does not settle it', async () => {
    await sync(dbMe, targetA, ME, T_A)
    await sync(dbMe, targetB, ME, T_B)
    // A row of X that arrives now (say through an unverifiable snapshot) is
    // unresolved as of this sync tick; the verdicts A and B already recorded
    // predate it and must not count.
    insertSyncedRecord(dbMe, { ...wire[0], id: 'late-arrival' })
    const a = await sync(dbMe, targetA, ME, T_A)
    expect(a.prunedCount).toBe(0)
    expect(syncedIds(dbMe, X)).toContain('late-arrival')
    const b = await sync(dbMe, targetB, ME, T_B)
    expect(b.prunedCount).toBe(1)
    expect(syncedIds(dbMe, X)).not.toContain('late-arrival')
  })
})

describe('I5/I6/I7 — what a namespace with no listed day file means', () => {
  let dbX: Database.Database
  let dbMe: Database.Database
  let target: FakeSyncBackend
  let ids: string[]

  beforeEach(async () => {
    dbX = newDb()
    dbMe = newDb()
    target = new FakeSyncBackend()
    const records = [0, 1].map(n => local(X, n))
    for (const r of records) insertRecord(dbX, r)
    ids = records.map(r => mapStatsRecordToSyncRecord(r).id).sort()
    await sync(dbX, target, X, T_A, [T_A])
    await sync(dbMe, target, ME, T_A, [T_A])
    expect(syncedIds(dbMe, X)).toEqual(ids)
    for (const id of ids) expect(getClaimingTargets(dbMe, id)).toEqual([T_A])
  })

  it('no day files and no manifest: the namespace was deleted, its rows go', async () => {
    for (const p of dayFilesOf(target, X)) target.files.delete(p)
    target.files.delete(manifestPath(X))
    const b = await sync(dbMe, target, ME, T_A, [T_A])
    expect(b).toMatchObject({ status: 'ok', prunedCount: 2, skippedNamespaces: 0 })
    expect(syncedIds(dbMe, X)).toEqual([])
    expect(mergedIds(dbMe, X)).toEqual([])
  })

  it('a valid empty manifest: the namespace is authoritatively empty, its rows go', async () => {
    for (const p of dayFilesOf(target, X)) target.files.delete(p)
    target.files.set(manifestPath(X), serializeManifest(buildManifest(new Map())))
    const b = await sync(dbMe, target, ME, T_A, [T_A])
    expect(b).toMatchObject({ status: 'ok', prunedCount: 2, skippedNamespaces: 0 })
    expect(syncedIds(dbMe, X)).toEqual([])
  })

  it('a manifest naming day files that are gone: unverifiable, claims and rows are kept', async () => {
    for (const p of dayFilesOf(target, X)) target.files.delete(p)
    const b = await sync(dbMe, target, ME, T_A, [T_A])
    expect(b).toMatchObject({ status: 'ok', prunedCount: 0, skippedNamespaces: 1 })
    expect(syncedIds(dbMe, X)).toEqual(ids)
    for (const id of ids) expect(getClaimingTargets(dbMe, id)).toEqual([T_A])
  })

  it('a manifest that does not parse: unverifiable, claims and rows are kept', async () => {
    for (const p of dayFilesOf(target, X)) target.files.delete(p)
    target.files.set(manifestPath(X), '{ not json')
    const b = await sync(dbMe, target, ME, T_A, [T_A])
    expect(b).toMatchObject({ status: 'ok', prunedCount: 0, skippedNamespaces: 1 })
    expect(syncedIds(dbMe, X)).toEqual(ids)
  })

  it('the same three states decide the fate of unresolved rows, and repair agrees', async () => {
    seedPreV14(dbMe, [{ ...mapStatsRecordToSyncRecord(local(GONE, 0)), id: 'gone-0' }])

    // A manifest naming a file that is not there: not absent, not judged.
    target.files.set(manifestPath(GONE), serializeManifest(buildManifest(new Map([['2026/09/06.ndjson', [mapStatsRecordToSyncRecord(local(GONE, 0))]]]))))
    let b = await sync(dbMe, target, ME, T_A, [T_A])
    expect(b).toMatchObject({ prunedCount: 0, skippedNamespaces: 1 })
    expect(syncedIds(dbMe, GONE)).toEqual(['gone-0'])
    let dry = await repairSyncContamination(dbMe, { deviceInstanceId: ME, target: T_A, backend: target })
    expect(dry.local.orphanedSyncedIds).toEqual([])

    // A valid empty manifest: judged empty.
    target.files.set(manifestPath(GONE), serializeManifest(buildManifest(new Map())))
    b = await sync(dbMe, target, ME, T_A, [T_A])
    expect(b).toMatchObject({ prunedCount: 1, skippedNamespaces: 0 })
    expect(syncedIds(dbMe, GONE)).toEqual([])

    // Nothing at all: absent — and repair reports it before sync settles it.
    seedPreV14(dbMe, [{ ...mapStatsRecordToSyncRecord(local(GONE, 1)), id: 'gone-1' }])
    target.files.delete(manifestPath(GONE))
    dry = await repairSyncContamination(dbMe, { deviceInstanceId: ME, target: T_A, backend: target })
    expect(dry.local.orphanedSyncedIds).toEqual(['gone-1'])
    b = await sync(dbMe, target, ME, T_A, [T_A])
    expect(b).toMatchObject({ prunedCount: 1, skippedNamespaces: 0 })
    expect(syncedIds(dbMe, GONE)).toEqual([])
  })
})

describe('I6/I7 — unverified snapshots', () => {
  let dbX: Database.Database
  let dbMe: Database.Database
  let targetA: FakeSyncBackend
  let targetB: FakeSyncBackend
  let r0: SyncRecord

  beforeEach(async () => {
    dbX = newDb()
    dbMe = newDb()
    targetA = new FakeSyncBackend()
    targetB = new FakeSyncBackend()
    insertRecord(dbX, local(X, 0))
    r0 = mapStatsRecordToSyncRecord(local(X, 0))
    await sync(dbX, targetA, X, T_A)
    await sync(dbX, targetB, X, T_B)
    await sync(dbMe, targetA, ME, T_A)
    await sync(dbMe, targetB, ME, T_B)
    expect(tokens(dbMe, r0.id)).toBe(100)
    expect(getClaimingTargets(dbMe, r0.id).sort()).toEqual([T_A, T_B].sort())
  })

  it('may update an existing claimed record and add rows, but never prune or release a claim', async () => {
    // The owner rewrote the day file (newer token data, one more record) and
    // crashed before publishing the manifest: the digest no longer matches.
    const path = dayFilesOf(targetA, X)[0]
    const newer = { ...r0, inputTokens: 250, updatedAt: r0.updatedAt + 1 }
    const extra = { ...r0, id: 'r-extra', updatedAt: r0.updatedAt + 1 }
    targetA.files.set(path, JSON.stringify(newer) + '\n' + JSON.stringify(extra) + '\n')

    const b = await sync(dbMe, targetA, ME, T_A)
    expect(b).toMatchObject({ status: 'ok', skippedNamespaces: 1, prunedCount: 0, pulledCount: 2 })
    // The newer version is taken (recovering data from an owner that crashed mid-publish)…
    expect(tokens(dbMe, r0.id)).toBe(250)
    expect(mergedTokens(dbMe, r0.id)).toBe(250)
    // …the claims are untouched, and the new row is unresolved.
    expect(getClaimingTargets(dbMe, r0.id).sort()).toEqual([T_A, T_B].sort())
    expect(syncedIds(dbMe, X)).toEqual([r0.id, 'r-extra'].sort())
    expect(getClaimingTargets(dbMe, 'r-extra')).toEqual([])
  })

  it('a row read from an unverifiable snapshot on one target is not pruned by another target verifying the namespace', async () => {
    const path = dayFilesOf(targetA, X)[0]
    targetA.files.set(path, targetA.files.get(path)! + JSON.stringify({ ...r0, id: 'r-extra' }) + '\n')
    let a = await sync(dbMe, targetA, ME, T_A)
    expect(a).toMatchObject({ skippedNamespaces: 1, prunedCount: 0 })
    expect(syncedIds(dbMe, X)).toContain('r-extra')

    // B verifies X's namespace and does not contain r-extra: B has no claim
    // to release, and A has not judged the row yet.
    const b = await sync(dbMe, targetB, ME, T_B)
    expect(b).toMatchObject({ skippedNamespaces: 0, prunedCount: 0 })
    expect(syncedIds(dbMe, X)).toContain('r-extra')

    // The owner's next sync restores A's namespace; now A judges the row
    // absent too, and it goes.
    await sync(dbX, targetA, X, T_A)
    a = await sync(dbMe, targetA, ME, T_A)
    expect(a).toMatchObject({ skippedNamespaces: 0, prunedCount: 1 })
    expect(syncedIds(dbMe, X)).toEqual([r0.id])
  })
})

describe('I8 — one record, different versions on different targets', () => {
  it('the local value is the newest version ever observed, and survives on the claim of a target carrying an older one', async () => {
    const dbX = newDb()
    const dbMe = newDb()
    const targetA = new FakeSyncBackend()
    const targetB = new FakeSyncBackend()
    const record = local(X, 0)
    const id = mapStatsRecordToSyncRecord(record).id
    insertRecord(dbX, record)
    await sync(dbX, targetB, X, T_B) // B: v1 (100 tokens)
    dbX.prepare(`UPDATE records SET input_tokens = 150, updated_at = ? WHERE id = ?`).run(DAY + 1, record.id)
    await sync(dbX, targetA, X, T_A) // A: v2 (150 tokens)

    await sync(dbMe, targetA, ME, T_A)
    expect(tokens(dbMe, id)).toBe(150)
    await sync(dbMe, targetB, ME, T_B)
    expect(tokens(dbMe, id)).toBe(150) // v1 is older: not applied
    expect(mergedTokens(dbMe, id)).toBe(150)
    expect(getClaimingTargets(dbMe, id).sort()).toEqual([T_A, T_B].sort())

    // X drops the record from A only: B's claim keeps the row, at v2.
    dbX.prepare(`DELETE FROM records WHERE id = ?`).run(record.id)
    await sync(dbX, targetA, X, T_A)
    const a = await sync(dbMe, targetA, ME, T_A)
    expect(a.prunedCount).toBe(0)
    expect(tokens(dbMe, id)).toBe(150)
    expect(getClaimingTargets(dbMe, id)).toEqual([T_B])

    // Gone from B too: the last claim goes, and so does the row.
    await sync(dbX, targetB, X, T_B)
    const b = await sync(dbMe, targetB, ME, T_B)
    expect(b.prunedCount).toBe(1)
    expect(syncedIds(dbMe, X)).toEqual([])
    expect(mergedIds(dbMe, X)).toEqual([])
  })
})

describe("I4/I5 — legacy rows stamped 'unknown' across targets", () => {
  it('wait for a fully reliable sync of every known target', async () => {
    const dbX = newDb()
    const dbMe = newDb()
    const targetA = new FakeSyncBackend()
    const targetB = new FakeSyncBackend()
    insertRecord(dbX, local(X, 0))
    await sync(dbX, targetA, X, T_A)
    await sync(dbX, targetB, X, T_B)
    seedPreV14(dbMe, [{ ...mapStatsRecordToSyncRecord(local(X, 7)), id: 'legacy-unknown', deviceInstanceId: 'unknown' }])

    let a = await sync(dbMe, targetA, ME, T_A)
    expect(a).toMatchObject({ skippedNamespaces: 0, prunedCount: 0 })
    expect(syncedIds(dbMe, 'unknown')).toEqual(['legacy-unknown'])

    // B cannot be read reliably this time: it may still hold the row somewhere.
    targetB.files.set(manifestPath(X), '{ broken')
    let b = await sync(dbMe, targetB, ME, T_B)
    expect(b).toMatchObject({ skippedNamespaces: 1, prunedCount: 0 })
    expect(syncedIds(dbMe, 'unknown')).toEqual(['legacy-unknown'])

    await sync(dbX, targetB, X, T_B) // the owner republishes: the manifest is whole again
    b = await sync(dbMe, targetB, ME, T_B)
    expect(b).toMatchObject({ skippedNamespaces: 0, prunedCount: 1 })
    expect(syncedIds(dbMe, 'unknown')).toEqual([])
    expect(syncedIds(dbMe, X)).toHaveLength(1)
  })
})
