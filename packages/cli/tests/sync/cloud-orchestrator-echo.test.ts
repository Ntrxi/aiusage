import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { generateRecordId, generateSessionKey, generateSyncRecordId } from '@aiusage/core'
import type { SyncRecord } from '@aiusage/core'
import { initializeDatabase } from '../../src/db/index.js'
import { insertRecord } from '../../src/db/records.js'

// The cloud pull endpoint returns every device's records, including our own.
// For Claude Code the local id (hash of message id) differs from the wire id
// (hash of source file + offset), so without a device check our own records
// would be merged back as new "local" rows and pushed again with colliding ids.

const pulled: SyncRecord[] = []

vi.mock('../../src/sync/cloud.js', () => ({
  CloudSyncError: class CloudSyncError extends Error {},
  cloudPull: vi.fn(async () => ({ records: pulled, tombstones: [], hasMore: false, syncGeneration: 1 })),
  cloudPush: vi.fn(async () => ({ inserted: 0, updated: 0, skipped: 0, syncGeneration: 1 })),
}))

const ME = 'device-me'
const OTHER = 'device-other'
const FILE = 'C:\\Users\\alice\\.claude\\projects\\p\\s.jsonl'

function wire(deviceInstanceId: string, n: number): SyncRecord {
  return {
    id: generateSyncRecordId(deviceInstanceId, FILE, 100 * (n + 1)),
    ts: 1000 + n,
    tool: 'claude-code',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    cost: 0.001,
    costSource: 'pricing',
    sessionKey: generateSessionKey('dev', 'sess'),
    device: 'dev',
    deviceInstanceId,
    updatedAt: 1000,
    sourceFile: FILE,
    cwd: 'C:\\proj',
  }
}

describe('CloudSyncOrchestrator provenance', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
    vi.clearAllMocks()
    pulled.length = 0
  })

  it('ignores echoes of its own records and never re-pushes pulled records', async () => {
    const { CloudSyncOrchestrator } = await import('../../src/sync/cloud-orchestrator.js')
    const { cloudPush } = await import('../../src/sync/cloud.js')

    // Two local Claude Code records (parser-style ids), already pushed earlier.
    for (const n of [0, 1]) {
      insertRecord(db, {
        id: generateRecordId(ME, `msg-${n}`, 0), ts: 1000 + n, ingestedAt: 1000, updatedAt: 1000, syncedAt: 2000,
        lineOffset: 100 * (n + 1), tool: 'claude-code', model: 'claude-sonnet-4-6', provider: 'anthropic',
        inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: 0, cost: 0.001,
        costSource: 'pricing', sessionId: 'sess', sourceFile: FILE, cwd: 'C:\\proj', device: 'dev', deviceInstanceId: ME,
      })
    }
    db.prepare(`INSERT INTO sync_record_state (record_id, target, synced_at) SELECT id, 'cloud', 2000 FROM records`).run()

    // Server returns our own two records (wire ids) plus one from another device.
    pulled.push(wire(ME, 0), wire(ME, 1), wire(OTHER, 0))

    const result = await new CloudSyncOrchestrator(db, { deviceInstanceId: ME }).sync()
    expect(result.status).toBe('ok')
    expect(result.pulledCount).toBe(1)
    expect(result.mergedCount).toBe(1)
    expect(result.uploadedCount).toBe(0)
    expect(cloudPush).not.toHaveBeenCalled()

    expect(db.prepare(`SELECT COUNT(*) n FROM synced_records WHERE device_instance_id = ?`).get(ME)).toEqual({ n: 0 })
    expect(db.prepare(`SELECT COUNT(*) n FROM records WHERE origin = 'local'`).get()).toEqual({ n: 2 })
    const other = db.prepare(`SELECT origin, source_file, cwd FROM records WHERE device_instance_id = ?`).all(OTHER)
    expect(other).toEqual([{ origin: 'synced', source_file: FILE, cwd: 'C:\\proj' }])

    // Second sync: still nothing to push.
    const again = await new CloudSyncOrchestrator(db, { deviceInstanceId: ME }).sync()
    expect(again.uploadedCount).toBe(0)
    expect(cloudPush).not.toHaveBeenCalled()
  })
})
