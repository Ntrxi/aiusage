// Custom date ranges (from/to) must use local calendar-day boundaries, matching
// the preset day/week/month ranges, and daily aggregations (activeDays, daily
// token/cost series) must bucket by the same local days. Each describe block
// pins a non-UTC timezone so the assertions hold regardless of the machine's TZ.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import http from 'node:http'
import Database from 'better-sqlite3'
import { createApiServer } from '../../src/api/server.js'
import { initializeDatabase } from '../../src/db/index.js'

function useTimeZone(tz: string) {
  let original: string | undefined
  beforeAll(() => {
    original = process.env.TZ
    process.env.TZ = tz
  })
  afterAll(() => {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  })
}

function insertRecord(db: Database.Database, id: string, ts: number, inputTokens: number) {
  db.prepare(`
    INSERT INTO records (id, ts, ingested_at, synced_at, updated_at, line_offset,
      tool, model, provider, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, thinking_tokens, cost, cost_source, session_id,
      source_file, device, device_instance_id)
    VALUES (@id, @ts, @ingested_at, NULL, @updated_at, 0,
      'claude-code', 'claude-sonnet-4-6', 'anthropic', @input_tokens, 0, 0,
      0, 0, @cost, 'pricing', @session_id,
      '/tmp/session.jsonl', 'local-device', 'local-uuid-0000')
  `).run({ id, ts, ingested_at: Date.now(), updated_at: Date.now(), input_tokens: inputTokens, cost: inputTokens, session_id: `s-${id}` })
}

function useTestServer() {
  const ctx = { db: null as unknown as Database.Database, baseUrl: '' }
  let server: http.Server

  beforeEach(async () => {
    ctx.db = new Database(':memory:')
    initializeDatabase(ctx.db)
    server = createApiServer(ctx.db)
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        ctx.baseUrl = `http://127.0.0.1:${(server.address() as any).port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    ctx.db.close()
  })

  async function get(path: string): Promise<any> {
    const res = await fetch(`${ctx.baseUrl}${path}`)
    expect(res.ok).toBe(true)
    return res.json()
  }

  return {
    ctx,
    summary: (query: string) => get(`/api/summary?${query}`),
    tokenDays: async (query: string) => (await get(`/api/tokens?${query}`)).data as Array<{ date: string; inputTokens: number }>,
    costDays: async (query: string) => (await get(`/api/cost?${query}`)).data as Array<{ date: string; cost: number }>,
  }
}

describe('custom date ranges in America/New_York', () => {
  useTimeZone('America/New_York')
  const t = useTestServer()

  // Local June 1 2026 (EDT, UTC-4) spans 2026-06-01T04:00:00Z .. 2026-06-02T03:59:59.999Z
  const localMidnightJun1 = Date.UTC(2026, 5, 1, 4)
  const localMidnightJun2 = Date.UTC(2026, 5, 2, 4)

  it('is running in the pinned timezone', () => {
    expect(new Date(2026, 5, 1).getTimezoneOffset()).toBe(240)
  })

  it('selects exactly the local calendar days between from and to inclusive', async () => {
    const db = t.ctx.db
    insertRecord(db, 'before-start', localMidnightJun1 - 1, 1)          // May 31 23:59:59.999 local
    insertRecord(db, 'utc-day-start', Date.UTC(2026, 5, 1, 2), 2)       // May 31 22:00 local (inside the old UTC window)
    insertRecord(db, 'at-start', localMidnightJun1, 4)                  // Jun 1 00:00:00.000 local
    insertRecord(db, 'midday', Date.UTC(2026, 5, 1, 16), 8)             // Jun 1 12:00 local
    insertRecord(db, 'last-ms', localMidnightJun2 - 1, 16)              // Jun 1 23:59:59.999 local
    insertRecord(db, 'at-end', localMidnightJun2, 32)                   // Jun 2 00:00:00.000 local

    // Single-day range covers the full local day, including its final millisecond,
    // and nothing from the neighbouring days.
    expect((await t.summary('from=2026-06-01&to=2026-06-01')).inputTokens).toBe(4 + 8 + 16)

    // Multi-day range: end boundary is exclusive local midnight after `to`.
    expect((await t.summary('from=2026-05-31&to=2026-06-01')).inputTokens).toBe(1 + 2 + 4 + 8 + 16)
    expect((await t.summary('from=2026-06-01&to=2026-06-02')).inputTokens).toBe(4 + 8 + 16 + 32)
    expect((await t.summary('from=2026-06-02&to=2026-06-02')).inputTokens).toBe(32)
  })

  it('buckets activeDays and daily series by local calendar day', async () => {
    const db = t.ctx.db
    // Both records are on local June 1 but on different UTC dates (Jun 1 04:30Z and Jun 2 03:30Z).
    insertRecord(db, 'early', Date.UTC(2026, 5, 1, 4, 30), 1)
    insertRecord(db, 'late', Date.UTC(2026, 5, 2, 3, 30), 2)

    const query = 'from=2026-06-01&to=2026-06-01'
    expect((await t.summary(query)).activeDays).toBe(1)
    expect(await t.tokenDays(query)).toEqual([expect.objectContaining({ date: '2026-06-01', inputTokens: 3 })])
    expect(await t.costDays(query)).toEqual([{ date: '2026-06-01', cost: 3 }])

    // Two local days: May 31 22:00 local (Jun 1 02:00Z) lands in the May 31 bucket.
    insertRecord(db, 'prev-day', Date.UTC(2026, 5, 1, 2), 4)
    const wide = 'from=2026-05-31&to=2026-06-01'
    expect((await t.summary(wide)).activeDays).toBe(2)
    expect((await t.tokenDays(wide)).map(d => d.date)).toEqual(['2026-05-31', '2026-06-01'])
  })

  it('matches the preset day range for today', async () => {
    // Freeze the clock late in a local day so the assertions cannot straddle midnight.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(2026, 5, 1, 23, 30))
      const db = t.ctx.db
      insertRecord(db, 'yesterday-late', localMidnightJun1 - 1, 1)
      insertRecord(db, 'today-start', localMidnightJun1, 2)
      insertRecord(db, 'today-now', Date.now(), 4)

      const preset = await t.summary('range=day')
      const custom = await t.summary('from=2026-06-01&to=2026-06-01')
      expect(custom.inputTokens).toBe(2 + 4)
      expect(custom.inputTokens).toBe(preset.inputTokens)
      expect(custom.activeDays).toBe(preset.activeDays)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('custom date ranges where DST skips local midnight (America/Santiago)', () => {
  useTimeZone('America/Santiago')
  const t = useTestServer()

  it('is running in the pinned timezone', () => {
    // Chile DST begins 2026-09-06: local midnight does not exist, the day starts at 01:00.
    expect(new Date(2026, 8, 6).getHours()).toBe(1)
    expect(new Date(2026, 8, 7).getHours()).toBe(0)
  })

  it('ends a single-day range at the true local midnight of the next day', async () => {
    const db = t.ctx.db
    // Before the transition the offset is UTC-4; after it, UTC-3.
    insertRecord(db, 'sep5-last-ms', Date.UTC(2026, 8, 6, 3, 59, 59, 999), 1)   // Sep 5 23:59:59.999 local
    insertRecord(db, 'sep6-first', Date.UTC(2026, 8, 6, 4), 2)                  // Sep 6 01:00 local (first instant of the day)
    insertRecord(db, 'sep6-last-ms', Date.UTC(2026, 8, 7, 2, 59, 59, 999), 4)   // Sep 6 23:59:59.999 local
    insertRecord(db, 'sep7-midnight', Date.UTC(2026, 8, 7, 3), 8)               // Sep 7 00:00 local
    insertRecord(db, 'sep7-leaked-hour', Date.UTC(2026, 8, 7, 3, 30), 16)       // Sep 7 00:30 local (leaked by setDate(+1) on a 01:00 start)

    const query = 'from=2026-09-06&to=2026-09-06'
    const summary = await t.summary(query)
    expect(summary.inputTokens).toBe(2 + 4)
    expect(summary.activeDays).toBe(1)
    expect((await t.tokenDays(query)).map(d => d.date)).toEqual(['2026-09-06'])

    expect((await t.summary('from=2026-09-07&to=2026-09-07')).inputTokens).toBe(8 + 16)
  })
})
