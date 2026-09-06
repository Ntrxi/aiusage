import { describe, it, expect } from 'vitest'
import { generateSyncRecordId } from '@aiusage/core'
import type { StatsRecord } from '@aiusage/core'
import { mapStatsRecordToSyncRecord } from '../../src/sync/mapper.js'

// Multiple Claude Code records from ONE source file must never collapse into a
// single sync id. Locally parsed rows carry their byte offset; rows merged from
// synced_records carry offset 0 and must keep their wire id (provenance flag,
// not the source_file value, decides this).

const SOURCE_FILE = 'C:\\Users\\alice\\.claude\\projects\\C--Users-alice\\session.jsonl'

function record(overrides: Partial<StatsRecord>): StatsRecord {
  return {
    id: 'r',
    ts: 1776738085346,
    ingestedAt: 1776738085700,
    updatedAt: 1776738085700,
    lineOffset: 0,
    tool: 'claude-code',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 200,
    thinkingTokens: 0,
    cost: 0.001,
    costSource: 'pricing',
    sessionId: 'abc123',
    sourceFile: SOURCE_FILE,
    device: 'G14',
    deviceInstanceId: 'device-a',
    ...overrides,
  }
}

describe('mapper: sync ids for records sharing one source_file', () => {
  it('keeps the wire id of merged (origin = synced) rows even though line_offset is 0', () => {
    const merged = ['id-1', 'id-2', 'id-3'].map(id => record({ id, origin: 'synced', lineOffset: 0 }))
    const ids = merged.map(r => mapStatsRecordToSyncRecord(r).id)
    expect(ids).toEqual(['id-1', 'id-2', 'id-3'])
    expect(new Set(ids).size).toBe(3)
    // Without provenance every one of them would collide to this single id:
    const collided = generateSyncRecordId('device-a', SOURCE_FILE, 0)
    expect(ids).not.toContain(collided)
  })

  it('does not rely on a synced/ source_file prefix', () => {
    const merged = record({ id: 'wire-id', origin: 'synced', sourceFile: SOURCE_FILE })
    expect(mapStatsRecordToSyncRecord(merged).id).toBe('wire-id')
    const legacy = record({ id: 'wire-id-2', origin: 'synced', sourceFile: 'synced/device-a' })
    expect(mapStatsRecordToSyncRecord(legacy).id).toBe('wire-id-2')
  })

  it('derives distinct ids for local Claude Code rows from their byte offsets', () => {
    const locals = [120, 480, 900].map((lineOffset, i) => record({ id: `local-${i}`, lineOffset }))
    const ids = locals.map(r => mapStatsRecordToSyncRecord(r).id)
    expect(new Set(ids).size).toBe(3)
    expect(ids).toEqual([120, 480, 900].map(o => generateSyncRecordId('device-a', SOURCE_FILE, o)))
  })

  it('preserves source_file and cwd on the wire', () => {
    const wire = mapStatsRecordToSyncRecord(record({ id: 'x', origin: 'synced', cwd: 'C:\\proj' }))
    expect(wire.sourceFile).toBe(SOURCE_FILE)
    expect(wire.cwd).toBe('C:\\proj')
  })
})
