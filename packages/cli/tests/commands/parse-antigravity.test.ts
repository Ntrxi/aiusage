import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runParseAntigravity } from '../../src/commands/parse-antigravity.js'

function varint(value: number): Buffer {
  const bytes: number[] = []
  let remaining = value
  do {
    let byte = remaining % 128
    remaining = Math.floor(remaining / 128)
    if (remaining > 0) byte |= 0x80
    bytes.push(byte)
  } while (remaining > 0)
  return Buffer.from(bytes)
}

function field(number: number, value: number | Buffer | string): Buffer {
  if (typeof value === 'number') return Buffer.concat([varint(number * 8), varint(value)])
  const data = typeof value === 'string' ? Buffer.from(value) : value
  return Buffer.concat([varint(number * 8 + 2), varint(data.length), data])
}

function message(...fields: Buffer[]): Buffer {
  return Buffer.concat(fields)
}

function generationMetadata(options: {
  model: string
  input: number
  totalOutput: number
  cacheWrite: number
  cacheRead: number
  thinking: number
  responseOutput: number
  stepIndices: number[]
}): Buffer {
  const usage = message(
    field(2, options.input),
    field(3, options.totalOutput),
    field(4, options.cacheWrite),
    field(5, options.cacheRead),
    field(9, options.thinking),
    field(10, options.responseOutput),
  )
  const chatModel = message(field(4, usage), field(22, options.model))
  return message(field(1, chatModel), field(2, Buffer.concat(options.stepIndices.map(varint))))
}

function stepMetadata(ts: number): Buffer {
  const seconds = Math.floor(ts / 1000)
  const nanos = (ts % 1000) * 1_000_000
  return message(field(1, message(field(1, seconds), field(2, nanos))))
}

describe('parse-antigravity', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER);
      CREATE TABLE steps (idx INTEGER, metadata BLOB);
    `)
  })

  afterEach(() => db.close())

  it('imports exact usage from Antigravity generation metadata', () => {
    const createdAt = Date.UTC(2026, 8, 6, 14, 19, 29, 321)
    db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(7, stepMetadata(createdAt))
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, generationMetadata({
      model: 'gemini-3.8-flash',
      input: 12_727,
      totalOutput: 278,
      cacheWrite: 3,
      cacheRead: 8_151,
      thinking: 201,
      responseOutput: 77,
      stepIndices: [7, 8],
    }), 1)

    const result = runParseAntigravity(db, {
      dbPath: '/home/test/.gemini/antigravity/conversations/session-1.db',
      device: 'laptop',
      deviceInstanceId: 'device-123',
      now: Date.UTC(2026, 8, 7),
      fallbackTs: Date.UTC(2026, 8, 7),
      startIndex: 0,
    })

    expect(result.errors).toEqual([])
    expect(result.nextIndex).toBe(1)
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({
      ts: createdAt,
      tool: 'antigravity',
      model: 'gemini-3.8-flash',
      provider: 'google',
      inputTokens: 12_727,
      outputTokens: 77,
      cacheWriteTokens: 3,
      cacheReadTokens: 8_151,
      thinkingTokens: 201,
      sessionId: 'session-1',
      lineOffset: 0,
    })
  })

  it('resumes from the generation metadata index', () => {
    const data = generationMetadata({
      model: 'gemini-3.8-flash',
      input: 100,
      totalOutput: 25,
      cacheWrite: 0,
      cacheRead: 50,
      thinking: 5,
      responseOutput: 20,
      stepIndices: [],
    })
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, data, data.length)
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(1, data, data.length)

    const result = runParseAntigravity(db, {
      dbPath: '/tmp/session-1.db',
      device: 'laptop',
      deviceInstanceId: 'device-123',
      now: 2_000,
      fallbackTs: 1_000,
      startIndex: 1,
    })

    expect(result.records.map((record) => record.lineOffset)).toEqual([1])
    expect(result.nextIndex).toBe(2)
  })

  it('leaves an unfinished metadata row for a later parse', () => {
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, message(field(1, message())), 0)

    const result = runParseAntigravity(db, {
      dbPath: '/tmp/session-1.db',
      device: 'laptop',
      deviceInstanceId: 'device-123',
      now: 2_000,
      fallbackTs: 1_000,
      startIndex: 0,
    })

    expect(result.records).toEqual([])
    expect(result.nextIndex).toBe(0)
  })
})
