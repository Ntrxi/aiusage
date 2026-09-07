import { basename } from 'node:path'
import type Database from 'better-sqlite3'
import type { StatsRecord } from '@aiusage/core'
import { calculateCost, generateRecordId, inferProvider, resolvePrice } from '@aiusage/core'

export interface AntigravityImportOptions {
  dbPath: string
  device: string
  deviceInstanceId: string
  platform?: string
  now: number
  fallbackTs: number
  startIndex: number
  exchangeRate?: number
}

export interface AntigravityImportResult {
  records: StatsRecord[]
  nextIndex: number
  errors: string[]
}

interface ProtoField {
  number: number
  wireType: number
  value: number | Buffer
}

function readVarint(data: Buffer, start: number): { value: number; offset: number } {
  let value = 0
  let shift = 0
  let offset = start
  while (offset < data.length && shift < 56) {
    const byte = data[offset++]
    value += (byte & 0x7f) * (2 ** shift)
    if ((byte & 0x80) === 0) return { value, offset }
    shift += 7
  }
  throw new Error('invalid protobuf varint')
}

function readFields(data: Buffer): ProtoField[] {
  const fields: ProtoField[] = []
  let offset = 0
  while (offset < data.length) {
    const key = readVarint(data, offset)
    const number = Math.floor(key.value / 8)
    const wireType = key.value % 8
    if (number < 1) throw new Error('invalid protobuf field number')
    offset = key.offset

    if (wireType === 0) {
      const parsed = readVarint(data, offset)
      fields.push({ number, wireType, value: parsed.value })
      offset = parsed.offset
      continue
    }
    if (wireType === 1) {
      if (offset + 8 > data.length) throw new Error('truncated protobuf fixed64')
      fields.push({ number, wireType, value: data.subarray(offset, offset + 8) })
      offset += 8
      continue
    }
    if (wireType === 2) {
      const size = readVarint(data, offset)
      const end = size.offset + size.value
      if (end > data.length) throw new Error('truncated protobuf bytes')
      fields.push({ number, wireType, value: data.subarray(size.offset, end) })
      offset = end
      continue
    }
    if (wireType === 5) {
      if (offset + 4 > data.length) throw new Error('truncated protobuf fixed32')
      fields.push({ number, wireType, value: data.subarray(offset, offset + 4) })
      offset += 4
      continue
    }
    throw new Error(`unsupported protobuf wire type ${wireType}`)
  }
  return fields
}

function firstMessage(fields: ProtoField[], number: number): ProtoField[] {
  const field = fields.find((candidate) => candidate.number === number && candidate.wireType === 2)
  return field && Buffer.isBuffer(field.value) ? readFields(field.value) : []
}

function firstVarint(fields: ProtoField[], number: number): number | undefined {
  const field = fields.find((candidate) => candidate.number === number && candidate.wireType === 0)
  return field && typeof field.value === 'number' ? field.value : undefined
}

function firstString(fields: ProtoField[], numbers: number[]): string | undefined {
  for (const number of numbers) {
    const field = fields.find((candidate) => candidate.number === number && candidate.wireType === 2)
    if (!field || !Buffer.isBuffer(field.value)) continue
    const value = field.value.toString('utf8').trim()
    if (value) return value
  }
  return undefined
}

function repeatedVarints(fields: ProtoField[], number: number): number[] {
  const values: number[] = []
  for (const field of fields) {
    if (field.number !== number) continue
    if (field.wireType === 0 && typeof field.value === 'number') {
      values.push(field.value)
    } else if (field.wireType === 2 && Buffer.isBuffer(field.value)) {
      let offset = 0
      while (offset < field.value.length) {
        const parsed = readVarint(field.value, offset)
        values.push(parsed.value)
        offset = parsed.offset
      }
    }
  }
  return values
}

function timestampMs(metadata: Buffer): number | undefined {
  const timestamp = firstMessage(readFields(metadata), 1)
  const seconds = firstVarint(timestamp, 1)
  if (seconds == null) return undefined
  const nanos = firstVarint(timestamp, 2) ?? 0
  return seconds * 1000 + Math.floor(nanos / 1_000_000)
}

function normalizeModel(value: string | undefined): string {
  if (!value) return 'antigravity-unknown'
  const model = value.includes('/') ? value.split('/').pop() : value
  return model?.trim() || 'antigravity-unknown'
}

function hasTables(db: Database.Database): boolean {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('gen_metadata', 'steps')").all() as { name: string }[]
  return rows.some((row) => row.name === 'gen_metadata') && rows.some((row) => row.name === 'steps')
}

export function runParseAntigravity(db: Database.Database, options: AntigravityImportOptions): AntigravityImportResult {
  const { dbPath, device, deviceInstanceId, platform, now, fallbackTs, startIndex, exchangeRate } = options
  const records: StatsRecord[] = []
  const errors: string[] = []
  let nextIndex = Math.max(0, startIndex)

  if (!hasTables(db)) {
    return { records, nextIndex, errors: ['conversation database does not contain gen_metadata and steps tables'] }
  }

  const stepTimes = new Map<number, number>()
  const stepRows = db.prepare('SELECT idx, metadata FROM steps').all() as Array<{ idx: number; metadata: Buffer }>
  for (const row of stepRows) {
    if (!Buffer.isBuffer(row.metadata)) continue
    try {
      const ts = timestampMs(row.metadata)
      if (ts != null) stepTimes.set(Number(row.idx), ts)
    } catch {}
  }

  const rows = db.prepare('SELECT idx, data FROM gen_metadata WHERE idx >= ? ORDER BY idx').all(nextIndex) as Array<{ idx: number; data: Buffer }>
  const sessionId = basename(dbPath).replace(/\.db$/i, '') || 'unknown'

  for (const row of rows) {
    const index = Number(row.idx)
    try {
      if (!Buffer.isBuffer(row.data)) throw new Error('generation metadata is not a blob')
      const metadata = readFields(row.data)
      const chatModel = firstMessage(metadata, 1)
      const usage = firstMessage(chatModel, 4)
      const inputTokens = firstVarint(usage, 2) ?? 0
      const totalOutputTokens = firstVarint(usage, 3) ?? 0
      const cacheWriteTokens = firstVarint(usage, 4) ?? 0
      const cacheReadTokens = firstVarint(usage, 5) ?? 0
      const thinkingTokens = firstVarint(usage, 9) ?? 0
      const responseOutputTokens = firstVarint(usage, 10)
      const outputTokens = responseOutputTokens ?? Math.max(0, totalOutputTokens - thinkingTokens)
      const total = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + thinkingTokens

      // A metadata row can exist before the streamed response is finalized. Leave
      // the cursor on that row so a later parse can import its completed counters.
      if (total === 0) break

      const model = normalizeModel(firstString(chatModel, [22, 19, 21]))
      const provider = inferProvider(model)
      const stepIndices = repeatedVarints(metadata, 2)
      const recordTs = stepIndices.map((step) => stepTimes.get(step)).find((value) => value != null)
        ?? fallbackTs + index
      const tokenArgs = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, thinkingTokens }
      const hasPrice = resolvePrice(model) != null
      const cost = hasPrice ? calculateCost(model, tokenArgs, exchangeRate) : 0

      records.push({
        id: generateRecordId(deviceInstanceId, `antigravity:${sessionId}`, index),
        ts: recordTs,
        ingestedAt: now,
        updatedAt: now,
        lineOffset: index,
        tool: 'antigravity',
        model,
        provider,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        thinkingTokens,
        cost,
        costSource: hasPrice ? 'pricing' : 'unknown',
        sessionId,
        sourceFile: dbPath,
        device,
        deviceInstanceId,
        platform,
      })
      nextIndex = index + 1
    } catch (error) {
      errors.push(`generation metadata ${index}: ${error instanceof Error ? error.message : error}`)
      nextIndex = index + 1
    }
  }

  return { records, nextIndex, errors }
}
