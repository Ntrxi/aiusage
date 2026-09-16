import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SyncRecord } from '@aiusage/core'

vi.mock('../../src/leaderboard/credentials.js', () => ({
  loadCredentials: () => ({ device_id: 'dev-1', device_secret: 'secret' }),
}))
vi.mock('../../src/site-url.js', () => ({ getSiteUrl: () => 'https://sync.test' }))

import { fromCloudRecord, toCloudRecord } from '../../src/sync/cloud-dto.js'
import { cloudPull, cloudPush, CloudSyncError } from '../../src/sync/cloud.js'

// The core `SyncRecord` calls the device alias `device`; the cloud API calls
// it `deviceName` on both push and pull, and hands integers back as strings
// (Postgres bigints). The DTO layer is the only place that knows.

const record: SyncRecord = {
  id: 'w1',
  ts: 1_757_160_000_000,
  tool: 'claude-code',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  inputTokens: 120,
  outputTokens: 30,
  cacheReadTokens: 5,
  cacheWriteTokens: 0,
  thinkingTokens: 0,
  cost: 0.00123,
  costSource: 'pricing',
  sessionKey: 'k1',
  device: 'MSI',
  deviceInstanceId: 'device-x',
  platform: 'win32',
  updatedAt: 1_757_160_000_001,
  sourceFile: 'C:\\s.jsonl',
  cwd: 'C:\\proj',
}

/** A record exactly as `/api/cli/sync/pull` serialises it. */
const serverRecord = {
  id: 'w1',
  ts: '1757160000000',
  tool: 'claude-code',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  inputTokens: '120',
  outputTokens: '30',
  cacheReadTokens: '5',
  cacheWriteTokens: '0',
  thinkingTokens: '0',
  cost: '0.00123',
  costSource: 'pricing',
  sessionKey: 'k1',
  sourceFile: 'C:\\s.jsonl',
  cwd: 'C:\\proj',
  deviceInstanceId: 'device-x',
  deviceName: 'MSI',
  platform: 'win32',
  updatedAt: '1757160000001',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('cloud DTO', () => {
  it('serialises the device alias as deviceName and nothing else changes', () => {
    const wire = toCloudRecord(record)
    expect(wire).not.toHaveProperty('device')
    expect(wire.deviceName).toBe('MSI')
    const { device, ...rest } = record
    expect(wire).toEqual({ ...rest, deviceName: device })
  })

  it('parses the server shape back into a SyncRecord, numbers included', () => {
    expect(fromCloudRecord(serverRecord)).toEqual(record)
  })

  it('accepts `device` from a server that predates deviceName, and fills defaults', () => {
    const { deviceName, ...rest } = serverRecord
    expect(fromCloudRecord({ ...rest, device: 'OLD' })?.device).toBe('OLD')
    const minimal = fromCloudRecord({ id: 'w2', deviceInstanceId: 'd', tool: 'codex', model: 'm', ts: 1, updatedAt: 2, cost: null, platform: null, sourceFile: null })
    expect(minimal).toEqual({
      id: 'w2', ts: 1, tool: 'codex', model: 'm', provider: '', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      cacheWriteTokens: 0, thinkingTokens: 0, cost: 0, costSource: 'unknown', sessionKey: '', device: '', deviceInstanceId: 'd', updatedAt: 2,
    })
  })

  it('rejects records without the fields a SyncRecord must have', () => {
    expect(fromCloudRecord(null)).toBeNull()
    expect(fromCloudRecord({ ...serverRecord, id: undefined })).toBeNull()
    expect(fromCloudRecord({ ...serverRecord, deviceInstanceId: '' })).toBeNull()
    expect(fromCloudRecord({ ...serverRecord, ts: 'yesterday' })).toBeNull()
    expect(fromCloudRecord({ ...serverRecord, updatedAt: undefined })).toBeNull()
  })
})

describe('cloud API boundary', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('push sends deviceName, not device', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'accepted', inserted: 1, updated: 0, skipped: 0, sync_generation: 3, server_cursor: '9' }))
    const result = await cloudPush([record], [{ record_id: 'old', updatedAt: 1 }], 'device-x', 3)
    expect(result).toEqual({ inserted: 1, updated: 0, skipped: 0, serverCursor: '9', syncGeneration: 3 })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://sync.test/api/cli/sync/push')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.device_instance_id).toBe('device-x')
    expect(body.sync_generation).toBe(3)
    expect(body.records).toHaveLength(1)
    expect(body.records[0].deviceName).toBe('MSI')
    expect(body.records[0]).not.toHaveProperty('device')
    expect(body.records[0].deviceInstanceId).toBe('device-x')
    expect(body.tombstones).toEqual([{ record_id: 'old', updatedAt: 1 }])
  })

  it('pull normalises deviceName and bigint strings into SyncRecords', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      records: [serverRecord],
      tombstones: [{ id: 't1', device_instance_id: 'device-y', deleted_at: '2026-09-16T00:00:00Z', updated_at: '5' }],
      sync_generation: 2,
      next_cursor: null,
      has_more: false,
    }))
    const result = await cloudPull()
    expect(result.records).toEqual([record])
    expect(result.tombstones).toEqual([{ id: 't1', device_instance_id: 'device-y', deleted_at: '2026-09-16T00:00:00Z', updated_at: '5' }])
    expect(result).toMatchObject({ syncGeneration: 2, hasMore: false, nextCursor: undefined })
  })

  it('pull fails rather than silently dropping a record it cannot represent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ records: [serverRecord, { id: 'broken' }], tombstones: [], sync_generation: 2, has_more: false }))
    const promise = cloudPull()
    await expect(promise).rejects.toBeInstanceOf(CloudSyncError)
    await promise.catch((e: CloudSyncError) => expect(e.code).toBe('invalid_response'))
  })
})
