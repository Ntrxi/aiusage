// Custom date ranges (from/to) must use local calendar-day boundaries, matching
// the preset day/week/month ranges. Pin a non-UTC timezone so the test is
// meaningful regardless of the machine's TZ.
process.env.TZ = 'America/New_York'

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import Database from 'better-sqlite3'
import { createApiServer } from '../../src/api/server.js'
import { initializeDatabase } from '../../src/db/index.js'

function insertRecord(db: Database.Database, id: string, ts: number, inputTokens: number) {
  db.prepare(`
    INSERT INTO records (id, ts, ingested_at, synced_at, updated_at, line_offset,
      tool, model, provider, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, thinking_tokens, cost, cost_source, session_id,
      source_file, device, device_instance_id)
    VALUES (@id, @ts, @ingested_at, NULL, @updated_at, 0,
      'claude-code', 'claude-sonnet-4-6', 'anthropic', @input_tokens, 0, 0,
      0, 0, 0, 'pricing', @session_id,
      '/tmp/session.jsonl', 'local-device', 'local-uuid-0000')
  `).run({ id, ts, ingested_at: Date.now(), updated_at: Date.now(), input_tokens: inputTokens, session_id: `s-${id}` })
}

describe('custom date range boundaries (local time)', () => {
  let db: Database.Database
  let server: http.Server
  let baseUrl: string

  beforeEach(async () => {
    expect(new Date(2026, 5, 1).getTimezoneOffset()).toBe(240) // EDT: UTC-4
    db = new Database(':memory:')
    initializeDatabase(db)
    server = createApiServer(db)
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as any).port}`
        resolve()
      })
    })
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    db.close()
  })

  async function summaryTokens(query: string): Promise<number> {
    const res = await fetch(`${baseUrl}/api/summary?${query}`)
    expect(res.ok).toBe(true)
    return (await res.json()).inputTokens
  }

  it('selects exactly the local calendar days between from and to inclusive', async () => {
    // Local June 1 2026 (EDT) spans 2026-06-01T04:00:00Z .. 2026-06-02T03:59:59.999Z
    const localMidnightJun1 = Date.UTC(2026, 5, 1, 4, 0, 0, 0)
    const localMidnightJun2 = Date.UTC(2026, 5, 2, 4, 0, 0, 0)

    insertRecord(db, 'before-start', localMidnightJun1 - 1, 1)          // May 31 23:59:59.999 local
    insertRecord(db, 'utc-day-start', Date.UTC(2026, 5, 1, 2, 0, 0), 2)   // May 31 22:00 local (inside the old UTC window)
    insertRecord(db, 'at-start', localMidnightJun1, 4)                    // Jun 1 00:00:00.000 local
    insertRecord(db, 'midday', Date.UTC(2026, 5, 1, 16, 0, 0), 8)         // Jun 1 12:00 local
    insertRecord(db, 'last-ms', localMidnightJun2 - 1, 16)                // Jun 1 23:59:59.999 local
    insertRecord(db, 'at-end', localMidnightJun2, 32)                     // Jun 2 00:00:00.000 local

    // Single-day range covers the full local day, including its final millisecond,
    // and nothing from the neighbouring days.
    expect(await summaryTokens('from=2026-06-01&to=2026-06-01')).toBe(4 + 8 + 16)

    // Multi-day range: end boundary is exclusive local midnight after `to`.
    expect(await summaryTokens('from=2026-05-31&to=2026-06-01')).toBe(1 + 2 + 4 + 8 + 16)
    expect(await summaryTokens('from=2026-06-01&to=2026-06-02')).toBe(4 + 8 + 16 + 32)
    expect(await summaryTokens('from=2026-06-02&to=2026-06-02')).toBe(32)
  })

  it('matches the preset day range for today', async () => {
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

    insertRecord(db, 'yesterday-late', today.getTime() - 1, 1)
    insertRecord(db, 'today-start', today.getTime(), 2)
    insertRecord(db, 'today-now', now.getTime(), 4)

    const preset = await summaryTokens('range=day')
    const custom = await summaryTokens(`from=${todayStr}&to=${todayStr}`)
    expect(custom).toBe(preset)
    expect(custom).toBe(2 + 4)
  })
})
