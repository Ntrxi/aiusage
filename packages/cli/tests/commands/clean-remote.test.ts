import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { generateRecordId } from '@aiusage/core'
import type { StatsRecord, SyncRecord } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord } from '../../src/db/records.js'
import { dropDanglingClaims } from '../../src/db/sync-claims.js'
import { cleanRemoteBefore } from '../../src/commands/clean.js'
import { SyncOrchestrator, serializeSnapshot } from '../../src/sync/index.js'
import { canonicalDigest, manifestPath, parseManifest } from '../../src/sync/manifest.js'
import { mapStatsRecordToSyncRecord } from '../../src/sync/mapper.js'
import { FakeSyncBackend } from '../sync/helpers/fake-backend.js'

// `aiusage clean --before` rewrites the remote day files of every namespace.
// It has to follow the snapshot rules of sync and `sync --repair`: kept
// records in canonical form, the manifest refreshed before any deletion, so
// that peers keep verifying the namespaces it touched and converge on the
// cleaned state instead of skipping them forever.

const A = 'device-a'
const B = 'device-b'
const C = 'device-c' // still on a pre-manifest client
const D = 'device-d'
const TARGET = 'github:example/repo'
const DAY = 86_400_000
const HOUR = 3_600_000
const NOW = Date.UTC(2026, 8, 16, 12, 0, 0)
const CUTOFF = NOW - 30 * DAY // 2026-08-17T12:00Z

function local(owner: string, n: number, ts: number): StatsRecord {
  return {
    id: generateRecordId(owner, `msg_${n}`, 0),
    ts,
    ingestedAt: ts,
    updatedAt: ts,
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
  }
}

function newDb(): Database.Database {
  const db = new Database(':memory:')
  initializeDatabase(db)
  return db
}

function sync(db: Database.Database, backend: FakeSyncBackend, deviceInstanceId: string) {
  return new SyncOrchestrator(db, backend, { deviceInstanceId, target: TARGET, consentVerified: true }).sync()
}

const syncedIds = (db: Database.Database, owner: string) =>
  (db.prepare(`SELECT id FROM synced_records WHERE device_instance_id = ? ORDER BY id`).all(owner) as Array<{ id: string }>).map(r => r.id)
const ndjson = (records: SyncRecord[]) => records.map(r => JSON.stringify(r)).join('\n') + '\n'

/** Records every write and deletion in the order it happened. */
class OrderedBackend extends FakeSyncBackend {
  readonly ops: string[] = []
  override async writeFile(path: string, content: string): Promise<void> {
    this.ops.push(`write ${path}`)
    return super.writeFile(path, content)
  }
  override async deleteFile(path: string): Promise<void> {
    this.ops.push(`delete ${path}`)
    return super.deleteFile(path)
  }
}

describe('clean --before on a file-based target', () => {
  let backend: OrderedBackend
  let dbA: Database.Database
  let dbB: Database.Database
  let wiresA: SyncRecord[]
  let wiresC: SyncRecord[]

  beforeEach(async () => {
    backend = new OrderedBackend()
    dbA = newDb()
    dbB = newDb()
    // A: two records on the cutoff day (one either side of the cutoff), one
    // well before it (a file that will empty out), one recent.
    const recordsA = [
      local(A, 0, CUTOFF - HOUR),
      local(A, 1, CUTOFF + HOUR),
      local(A, 2, CUTOFF - 10 * DAY),
      local(A, 3, NOW - DAY),
    ]
    for (const r of recordsA) insertRecord(dbA, r)
    wiresA = recordsA.map(mapStatsRecordToSyncRecord)
    await sync(dbA, backend, A)
    expect(backend.files.has(manifestPath(A))).toBe(true)

    // C: a legacy namespace without manifest, one old and one recent file.
    wiresC = [local(C, 0, CUTOFF - 10 * DAY), local(C, 1, NOW - DAY)].map(mapStatsRecordToSyncRecord)
    backend.files.set(`${C}/2026/08/07.ndjson`, ndjson([wiresC[0]]))
    backend.files.set(`${C}/2026/09/15.ndjson`, ndjson([wiresC[1]]))

    await sync(dbB, backend, B)
    expect(syncedIds(dbB, A)).toHaveLength(4)
    expect(syncedIds(dbB, C)).toHaveLength(2)
    backend.ops.length = 0
  })

  it('rewrites kept records canonically, refreshes the manifest before deleting emptied files, and leaves legacy namespaces manifest-less', async () => {
    const result = await cleanRemoteBefore(backend, CUTOFF, B)
    expect(result).toEqual({ removedRecords: 3, modifiedFiles: 3 })

    // A: the cutoff-day file keeps only the later record, in canonical form;
    // the old file is gone; the manifest names exactly the remaining files
    // with the digests peers will compute.
    expect(backend.files.get(`${A}/2026/08/17.ndjson`)).toBe(serializeSnapshot([wiresA[1]]))
    expect(backend.files.has(`${A}/2026/08/07.ndjson`)).toBe(false)
    expect(backend.files.get(`${A}/2026/09/15.ndjson`)).toBe(serializeSnapshot([wiresA[3]]))
    expect(parseManifest(backend.files.get(manifestPath(A))!)).toEqual({
      version: 1,
      files: {
        '2026/08/17.ndjson': { digest: canonicalDigest([wiresA[1]]), records: 1 },
        '2026/09/15.ndjson': { digest: canonicalDigest([wiresA[3]]), records: 1 },
      },
    })
    expect(backend.ops.indexOf(`write ${A}/2026/08/17.ndjson`)).toBeLessThan(backend.ops.indexOf(`write ${manifestPath(A)}`))
    expect(backend.ops.indexOf(`write ${manifestPath(A)}`)).toBeLessThan(backend.ops.indexOf(`delete ${A}/2026/08/07.ndjson`))

    // C: its old file is gone, its recent file untouched, and no manifest was
    // invented for a namespace its owner's client would never maintain.
    expect(backend.files.has(`${C}/2026/08/07.ndjson`)).toBe(false)
    expect(backend.files.get(`${C}/2026/09/15.ndjson`)).toBe(ndjson([wiresC[1]]))
    expect(backend.files.has(manifestPath(C))).toBe(false)
  })

  it('leaves namespaces that keep every record untouched', async () => {
    await cleanRemoteBefore(backend, CUTOFF - 20 * DAY, B)
    expect(backend.ops).toEqual([])
  })

  it('publishes an empty manifest before deleting every file of a namespace that empties out', async () => {
    const result = await cleanRemoteBefore(backend, NOW + DAY, B)
    expect(result.removedRecords).toBe(6)
    expect(backend.ops.indexOf(`write ${manifestPath(A)}`)).toBeLessThan(backend.ops.indexOf(`delete ${A}/2026/08/07.ndjson`))
    expect(parseManifest(backend.files.get(manifestPath(A))!)).toEqual({ version: 1, files: {} })
    expect([...backend.files.keys()].filter(p => p.endsWith('.ndjson'))).toEqual([])
    expect(backend.files.has(manifestPath(C))).toBe(false)

    const dbD = newDb()
    const d = await sync(dbD, backend, D)
    expect(d).toMatchObject({ status: 'ok', pulledCount: 0, skippedNamespaces: 0 })
  })

  it('lets peers verify and converge on the cleaned namespaces', async () => {
    await cleanRemoteBefore(backend, CUTOFF, B)

    // A fresh device mirrors exactly what the cleanup left.
    const dbD = newDb()
    const d = await sync(dbD, backend, D)
    expect(d).toMatchObject({ status: 'ok', skippedNamespaces: 0, pulledCount: 3 })
    expect(syncedIds(dbD, A)).toEqual([wiresA[1].id, wiresA[3].id].sort())
    expect(syncedIds(dbD, C)).toEqual([wiresC[1].id])

    // The device that ran the cleanup reconciles its mirror without skipping.
    const b = await sync(dbB, backend, B)
    expect(b).toMatchObject({ status: 'ok', skippedNamespaces: 0, prunedCount: 3, pulledCount: 0 })
    expect(syncedIds(dbB, A)).toEqual([wiresA[1].id, wiresA[3].id].sort())

    // The owner, once its own database was cleaned the same way, finds its
    // namespace already canonical: nothing is rewritten.
    dbA.prepare(`DELETE FROM records WHERE ts < ?`).run(CUTOFF)
    dbA.prepare(`DELETE FROM synced_records WHERE ts < ?`).run(CUTOFF)
    dropDanglingClaims(dbA)
    const a = await sync(dbA, backend, A)
    expect(a).toMatchObject({ status: 'ok', writtenFiles: 0, retiredCount: 0 })

    // Repeated syncs are no-ops.
    const mutations = backend.mutations.length
    for (const [db, dev] of [[dbA, A], [dbB, B], [dbD, D]] as const) {
      const r = await sync(db, backend, dev)
      expect(r).toMatchObject({ status: 'ok', pulledCount: 0, prunedCount: 0, skippedNamespaces: 0 })
    }
    expect(backend.mutations.length).toBe(mutations)
  })
})
