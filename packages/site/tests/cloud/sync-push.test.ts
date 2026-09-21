import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory stand-in for cloud_usage_records, keyed by record_id -> updated_at.
// The fake mirrors what Postgres returns for the route's UPSERT ... RETURNING:
// one row with inserted=true for a new row, inserted=false for a conflict update,
// and no row at all when the conflict WHERE rejects an older/equal record.
const db = vi.hoisted(() => ({
  rows: new Map<string, number>(),
  upsertQueries: [] as string[],
}))

vi.mock('$lib/server/db/pool.js', () => {
  // Positions of record_id / updated_at in the UPSERT's VALUES list.
  const RECORD_ID_PARAM = 5
  const UPDATED_AT_PARAM = 22

  const sql = (strings: TemplateStringsArray, ...params: unknown[]) => {
    const text = strings.join('?')
    if (text.includes('INSERT INTO cloud_usage_records')) {
      db.upsertQueries.push(text)
      const recordId = params[RECORD_ID_PARAM] as string
      const updatedAt = params[UPDATED_AT_PARAM] as number
      const current = db.rows.get(recordId)
      if (current === undefined) {
        db.rows.set(recordId, updatedAt)
        return Promise.resolve([{ inserted: true }])
      }
      if (updatedAt > current) {
        db.rows.set(recordId, updatedAt)
        return Promise.resolve([{ inserted: false }])
      }
      return Promise.resolve([])
    }
    if (text.includes('FROM cloud_device_instances')) {
      return Promise.resolve([{ id: 'instance_1', sync_generation: 1 }])
    }
    if (text.includes('MAX(change_seq)')) {
      return Promise.resolve([{ max_seq: db.rows.size }])
    }
    return Promise.resolve([])
  }
  sql.begin = (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql)
  return { sql }
})

vi.mock('$lib/server/uploads/verify.js', () => ({
  verifyUploadRequest: async () => ({
    valid: true,
    userId: 'user_1',
    deviceId: 'device_1',
    idempotencyKey: 'idem_1',
  }),
}))

vi.mock('$lib/server/config.js', () => ({
  CFG: {
    SYNC_MAX_RECORDS: 'sync_max_records',
    SYNC_MAX_TOMBSTONES: 'sync_max_tombstones',
    SYNC_BODY_MAX_SIZE: 'sync_body_max_size',
  },
  getConfigValue: async () => 1_000_000,
}))

vi.mock('$lib/server/cloud/star-check.js', () => ({
  checkCloudSyncAccess: async () => ({ allowed: true }),
}))

import { POST } from '../../src/routes/api/cli/sync/push/+server.js'

function record(id: string, updatedAt: number, overrides: Record<string, unknown> = {}) {
  return { id, ts: 1_000, tool: 'claude-code', model: 'claude-sonnet-4', updatedAt, ...overrides }
}

async function push(records: unknown[], tombstones: unknown[] = []) {
  const request = new Request('http://localhost/api/cli/sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema_version: 1,
      device_instance_id: 'instance_a',
      sync_generation: 1,
      records,
      tombstones,
    }),
  })
  const response = await POST({ request } as Parameters<typeof POST>[0])
  return { status: response.status, body: await response.json() }
}

describe('POST /api/cli/sync/push result counters', () => {
  beforeEach(() => {
    db.rows.clear()
    db.upsertQueries.length = 0
  })

  it('counts newly created rows as inserted', async () => {
    const { status, body } = await push([record('r1', 100), record('r2', 100)])
    expect(status).toBe(200)
    expect(body).toMatchObject({ status: 'accepted', inserted: 2, updated: 0, skipped: 0 })
  })

  it('counts a newer record for an existing row as updated', async () => {
    db.rows.set('r1', 100)
    const { body } = await push([record('r1', 200)])
    expect(body).toMatchObject({ inserted: 0, updated: 1, skipped: 0 })
    expect(db.rows.get('r1')).toBe(200)
  })

  it('counts stale and equal records as skipped', async () => {
    db.rows.set('r1', 100)
    db.rows.set('r2', 100)
    const { body } = await push([record('r1', 50), record('r2', 100)])
    expect(body).toMatchObject({ inserted: 0, updated: 0, skipped: 2 })
    expect(db.rows.get('r1')).toBe(100)
  })

  it('classifies a mixed batch per record', async () => {
    db.rows.set('existing-newer', 100)
    db.rows.set('existing-stale', 100)
    const { body } = await push([
      record('fresh', 100),
      record('existing-newer', 200),
      record('existing-stale', 100),
      record('', 100),
      record('no-model', 100, { model: '' }),
    ])
    expect(body).toMatchObject({ inserted: 1, updated: 1, skipped: 3 })
  })

  it('asks the database which outcome the UPSERT had', async () => {
    await push([record('r1', 100)])
    expect(db.upsertQueries).toHaveLength(1)
    expect(db.upsertQueries[0]).toMatch(/RETURNING \(xmax = 0\) AS inserted/)
  })
})
