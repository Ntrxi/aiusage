import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateRecordId } from '@aiusage/core'
import type { StatsRecord } from '@aiusage/core'
import type { SyncConfig } from '../../src/config.js'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord } from '../../src/db/records.js'
import { getClaimingTargets, replaceNamespaceClaims } from '../../src/db/sync-claims.js'
import { adoptLegacySyncTarget, getLegacySyncTarget, getSyncTarget } from '../../src/sync/target.js'
import { SyncOrchestrator } from '../../src/sync/index.js'
import { mapStatsRecordToSyncRecord } from '../../src/sync/mapper.js'
import { knownSyncTargets } from '../../src/commands/sync.js'
import { FakeSyncBackend } from './helpers/fake-backend.js'

// The sync target key scopes consent, publish bookkeeping and record claims.
// Two configurations may share it only when they address the same physical
// store, otherwise reconciling one prunes rows the other still carries.

const github = (over: Partial<SyncConfig> = {}): SyncConfig => ({ backend: 'github', repo: 'org/usage', ...over })
const s3 = (over: Partial<SyncConfig> = {}): SyncConfig => ({ backend: 's3', bucket: 'usage', ...over })

describe('getSyncTarget', () => {
  it('keeps the legacy keys for default configurations', () => {
    expect(getSyncTarget(github())).toBe('github:org/usage')
    expect(getSyncTarget(github({ branch: 'main' }))).toBe('github:org/usage')
    expect(getSyncTarget(github({ branch: ' main ' }))).toBe('github:org/usage')
    expect(getSyncTarget(s3())).toBe('s3:usage')
    expect(getSyncTarget(s3({ prefix: 'aiusage/' }))).toBe('s3:usage')
    expect(getSyncTarget(s3({ prefix: '/aiusage' }))).toBe('s3:usage')
    expect(getSyncTarget(s3({ endpoint: 'https://s3.amazonaws.com/' }))).toBe('s3:usage')
    expect(getSyncTarget(s3({ region: 'eu-west-1' }))).toBe('s3:usage')
    expect(getSyncTarget({ backend: 'cloud' })).toBe('cloud')
    expect(getSyncTarget(undefined)).toBeNull()
    expect(getSyncTarget({ backend: 'github' })).toBeNull()
  })

  it('distinguishes branches of the same repository', () => {
    const main = getSyncTarget(github())
    const other = getSyncTarget(github({ branch: 'usage-2026' }))
    expect(other).toBe('github:org/usage?branch=usage-2026')
    expect(other).not.toBe(main)
    expect(getSyncTarget(github({ branch: 'usage-2026' }))).toBe(other)
  })

  it('distinguishes prefixes of the same bucket, with normalised spelling', () => {
    const a = getSyncTarget(s3({ prefix: 'team-a/' }))
    const b = getSyncTarget(s3({ prefix: 'team-b/' }))
    expect(a).toBe('s3:usage?prefix=team-a%2F')
    expect(a).not.toBe(b)
    expect(getSyncTarget(s3({ prefix: 'team-a' }))).toBe(a)
    expect(getSyncTarget(s3({ prefix: '/team-a/' }))).toBe(a)
    expect(a).not.toBe(getSyncTarget(s3()))
  })

  it('distinguishes the same bucket name on different endpoints', () => {
    const r2 = getSyncTarget(s3({ endpoint: 'https://acct.r2.cloudflarestorage.com' }))
    const minio = getSyncTarget(s3({ endpoint: 'https://minio.internal:9000' }))
    expect(r2).toBe('s3:usage?endpoint=https%3A%2F%2Facct.r2.cloudflarestorage.com')
    expect(r2).not.toBe(minio)
    expect(r2).not.toBe(getSyncTarget(s3()))
    expect(getSyncTarget(s3({ endpoint: 'https://acct.r2.cloudflarestorage.com/' }))).toBe(r2)
    expect(getSyncTarget(s3({ endpoint: 'https://acct.r2.cloudflarestorage.com', prefix: 'x/' })))
      .toBe('s3:usage?prefix=x%2F&endpoint=https%3A%2F%2Facct.r2.cloudflarestorage.com')
  })

  it('reports the legacy key only when it differs from the current one', () => {
    expect(getLegacySyncTarget(github())).toBeNull()
    expect(getLegacySyncTarget(github({ branch: 'x' }))).toBe('github:org/usage')
    expect(getLegacySyncTarget(s3())).toBeNull()
    expect(getLegacySyncTarget(s3({ prefix: 'p/' }))).toBe('s3:usage')
    expect(getLegacySyncTarget(s3({ endpoint: 'https://e' }))).toBe('s3:usage')
    expect(getLegacySyncTarget({ backend: 'cloud' })).toBeNull()
    expect(getLegacySyncTarget(undefined)).toBeNull()
  })
})

describe('adoptLegacySyncTarget', () => {
  let dir: string
  let db: Database.Database
  const config = s3({ prefix: 'team-a/' })
  const target = getSyncTarget(config)!
  const legacy = 's3:usage'
  const state = () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'))
  const rows = (table: string, t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE target = ?`).get(t) as { n: number }).n

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aiusage-target-'))
    db = new Database(':memory:')
    initializeDatabase(db)
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      deviceInstanceId: 'me',
      lastSyncStatus: 'ok',
      lastSyncTarget: legacy,
      syncConsents: { [legacy]: { syncConsentAt: 1, syncConsentTarget: 'fp' } },
      syncTargets: { [legacy]: { lastSyncAt: 2, lastSyncStatus: 'ok', lastSyncTarget: legacy } },
    }))
    insertRecord(db, {
      id: 'r1', ts: 1, ingestedAt: 1, updatedAt: 1, lineOffset: 0, tool: 'claude-code', model: 'm', provider: 'p',
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, cost: 0,
      costSource: 'pricing', sessionId: 's', sourceFile: 'C:\\s.jsonl', device: 'D', deviceInstanceId: 'me',
    })
    db.prepare(`INSERT INTO sync_record_state (record_id, target, synced_at) VALUES ('r1', ?, 5)`).run(legacy)
    db.prepare(`INSERT INTO synced_records (id, ts, tool, model, provider, session_key, device, device_instance_id, updated_at) VALUES ('p1', 1, 't', 'm', 'p', 'k', 'X', 'device-x', 1)`).run()
    replaceNamespaceClaims(db, legacy, 'device-x', ['p1'])
    db.prepare(`INSERT INTO sync_retired_wire_ids (target, wire_id) VALUES (?, 'old')`).run(legacy)
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('copies state and bookkeeping recorded under the legacy key, once, leaving the legacy key in place', () => {
    const first = adoptLegacySyncTarget(dir, db, config)
    expect(first).toEqual({ target, legacy, stateCopied: true, syncStateRows: 1, claimRows: 1, retiredWireIdRows: 1, verdictRows: 0 })

    const s = state()
    expect(s.syncConsents[target]).toEqual({ syncConsentAt: 1, syncConsentTarget: 'fp' })
    expect(s.syncConsents[legacy]).toEqual({ syncConsentAt: 1, syncConsentTarget: 'fp' })
    expect(s.syncTargets[target]).toEqual({ lastSyncAt: 2, lastSyncStatus: 'ok', lastSyncTarget: target })
    expect(s.syncTargets[legacy].lastSyncTarget).toBe(legacy)
    for (const table of ['sync_record_state', 'sync_record_claims', 'sync_retired_wire_ids']) {
      expect(rows(table, target)).toBe(1)
      expect(rows(table, legacy)).toBe(1)
    }
    expect(getClaimingTargets(db, 'p1').sort()).toEqual([legacy, target].sort())

    // Idempotent: a second call copies nothing, even after the legacy key gained rows.
    db.prepare(`INSERT INTO sync_retired_wire_ids (target, wire_id) VALUES (?, 'newer')`).run(legacy)
    const second = adoptLegacySyncTarget(dir, db, config)
    expect(second).toEqual({ target, legacy, stateCopied: false, syncStateRows: 0, claimRows: 0, retiredWireIdRows: 0, verdictRows: 0 })
    expect(rows('sync_retired_wire_ids', target)).toBe(1)
  })

  it('does nothing for a default configuration or when the new key already has state', () => {
    expect(adoptLegacySyncTarget(dir, db, s3())).toBeNull()
    expect(adoptLegacySyncTarget(dir, db, { backend: 'cloud' })).toBeNull()

    replaceNamespaceClaims(db, target, 'device-y', ['p9'])
    const result = adoptLegacySyncTarget(dir, db, config)
    expect(result?.claimRows).toBe(0)
    expect(getClaimingTargets(db, 'p1')).toEqual([legacy])
    expect(result?.syncStateRows).toBe(1)
  })

  it('treats the legacy key as an alias of the current target among the known targets', () => {
    adoptLegacySyncTarget(dir, db, config)
    expect(knownSyncTargets(state(), target)).toEqual([legacy, target].sort())
    expect(knownSyncTargets(state(), target, [getLegacySyncTarget(config)])).toEqual([target])
    expect(knownSyncTargets({ ...state(), syncTargets: { ...state().syncTargets, cloud: {} } }, target, [legacy])).toEqual(['cloud', target].sort())
    expect(knownSyncTargets(null, target)).toEqual([target])
  })
})

describe('distinct stores never share claims', () => {
  const X = 'device-x'
  const B = 'device-b'
  const DAY = Date.UTC(2026, 8, 6, 12, 0, 0)

  function local(n: number): StatsRecord {
    return {
      id: generateRecordId(X, `msg_${n}`, 0), ts: DAY + n * 60_000, ingestedAt: DAY, updatedAt: DAY, lineOffset: 100 * (n + 1),
      tool: 'claude-code', model: 'm', provider: 'anthropic', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
      thinkingTokens: 0, cost: 0, costSource: 'pricing', sessionId: 'sess', sourceFile: 'C:\\s.jsonl', device: 'X', deviceInstanceId: X,
    }
  }

  const sync = (db: Database.Database, backend: FakeSyncBackend, device: string, target: string) =>
    new SyncOrchestrator(db, backend, { deviceInstanceId: device, target, consentVerified: true }).sync()

  it.each([
    ['same repository, different branches', github(), github({ branch: 'other' })],
    ['same bucket, different prefixes', s3({ prefix: 'a/' }), s3({ prefix: 'b/' })],
    ['same bucket name, different endpoints', s3({ endpoint: 'https://one.example' }), s3({ endpoint: 'https://two.example' })],
  ])('%s: dropping a record from one store keeps it while the other still carries it', async (_name, configA, configB) => {
    const targetA = getSyncTarget(configA)!
    const targetB = getSyncTarget(configB)!
    expect(targetA).not.toBe(targetB)

    const dbX = new Database(':memory:'); initializeDatabase(dbX)
    const dbB = new Database(':memory:'); initializeDatabase(dbB)
    const storeA = new FakeSyncBackend()
    const storeB = new FakeSyncBackend()
    const records = [0, 1].map(local)
    for (const r of records) insertRecord(dbX, r)
    await sync(dbX, storeA, X, targetA)
    await sync(dbX, storeB, X, targetB)
    await sync(dbB, storeA, B, targetA)
    await sync(dbB, storeB, B, targetB)
    const R = mapStatsRecordToSyncRecord(records[0]).id
    expect(getClaimingTargets(dbB, R).sort()).toEqual([targetA, targetB].sort())

    dbX.prepare(`DELETE FROM records WHERE id = ?`).run(records[0].id)
    await sync(dbX, storeB, X, targetB)
    const result = await sync(dbB, storeB, B, targetB)
    expect(result.prunedCount ?? 0).toBe(0)
    expect(getClaimingTargets(dbB, R)).toEqual([targetA])
    expect(dbB.prepare(`SELECT COUNT(*) AS n FROM synced_records WHERE id = ?`).get(R)).toEqual({ n: 1 })
  })
})
