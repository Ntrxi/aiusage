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

function message(...fields: Array<Buffer | undefined>): Buffer {
  return Buffer.concat(fields.filter((value): value is Buffer => value != null))
}

interface UsageOptions {
  modelId?: number
  input: number
  totalOutput: number
  cacheWrite?: number
  cacheRead?: number
  thinking?: number
  responseOutput?: number
  messageId?: string
  responseId?: string
  providerMessageId?: string
}

function usage(options: UsageOptions): Buffer {
  return message(
    options.modelId ? field(1, options.modelId) : undefined,
    field(2, options.input),
    field(3, options.totalOutput),
    field(4, options.cacheWrite ?? 0),
    field(5, options.cacheRead ?? 0),
    options.messageId ? field(7, options.messageId) : undefined,
    field(9, options.thinking ?? 0),
    field(10, options.responseOutput ?? Math.max(0, options.totalOutput - (options.thinking ?? 0))),
    options.responseId ? field(11, options.responseId) : undefined,
    options.providerMessageId ? field(12, options.providerMessageId) : undefined,
  )
}

function retry(value: Buffer): Buffer {
  return message(field(2, value))
}

function generationMetadata(options: {
  /** Model slug Antigravity selected (chat model field 19). */
  model?: string
  modelId?: number
  usage?: Buffer
  retries?: Buffer[]
  stepIndices?: number[]
  ts?: number
  /** `MODEL_PLACEHOLDER_M<n>` stored as the `model_enum` entry (chat model field 20). */
  placeholder?: string
  /** Display label such as `Gemini 3.8 Flash (High)` (chat model field 21). */
  label?: string
  /** Executor model embedded in the generation row (field 3 → 28). */
  executorModel?: string
}): Buffer {
  const chatModel = message(
    options.modelId ? field(3, options.modelId) : undefined,
    options.usage ? field(4, options.usage) : undefined,
    options.ts != null ? field(9, message(field(4, timestamp(options.ts)))) : undefined,
    ...(options.retries ?? []).map((value) => field(17, retry(value))),
    options.model ? field(19, options.model) : undefined,
    field(20, message(field(1, 'used_claude'), field(2, 'false'))),
    options.placeholder ? field(20, message(field(1, 'model_enum'), field(2, options.placeholder))) : undefined,
    options.label ? field(21, options.label) : undefined,
  )
  const stepIndices = options.stepIndices ?? []
  return message(
    field(1, chatModel),
    stepIndices.length > 0 ? field(2, Buffer.concat(stepIndices.map(varint))) : undefined,
    options.executorModel ? field(3, message(field(28, options.executorModel))) : undefined,
  )
}

function executorMetadata(model: string): Buffer {
  return message(field(28, model))
}

function timestamp(ts: number): Buffer {
  return message(
    field(1, Math.floor(ts / 1000)),
    field(2, (ts % 1000) * 1_000_000),
  )
}

function trajectoryMetadata(ts: number): Buffer {
  return message(field(2, timestamp(ts)))
}

function stepMetadata(options: {
  ts: number
  usage?: Buffer
  retries?: Buffer[]
  modelId?: number
  modelName?: string
}): Buffer {
  return message(
    field(1, timestamp(options.ts)),
    options.usage ? field(9, options.usage) : undefined,
    ...(options.retries ?? []).map((value) => field(28, retry(value))),
    options.modelId || options.modelName ? field(24, message(
      options.modelId ? field(1, options.modelId) : undefined,
      options.modelName ? field(12, options.modelName) : undefined,
    )) : undefined,
  )
}

const SCHEMA = `
  CREATE TABLE gen_metadata (idx INTEGER, data BLOB, size INTEGER);
  CREATE TABLE steps (idx INTEGER, metadata BLOB);
  CREATE TABLE executor_metadata (idx INTEGER, data BLOB);
  CREATE TABLE trajectory_metadata_blob (id TEXT, data BLOB);
`

describe('parse-antigravity', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(SCHEMA)
  })

  afterEach(() => db.close())

  function parse(startIndex = 0, target: Database.Database = db) {
    return runParseAntigravity(target, {
      dbPath: '/home/test/.gemini/antigravity/conversations/session-1.db',
      device: 'laptop',
      deviceInstanceId: 'device-123',
      now: Date.UTC(2026, 8, 7),
      fallbackTs: Date.UTC(2026, 8, 7),
      startIndex,
    })
  }

  function insertGeneration(index: number, data: Buffer): void {
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(index, data, data.length)
  }

  function insertStep(index: number, data: Buffer): void {
    db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(index, data)
  }

  it('imports exact usage from generation metadata', () => {
    const createdAt = Date.UTC(2026, 8, 6, 14, 19, 29, 321)
    db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(7, stepMetadata({ ts: createdAt }))
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, generationMetadata({
      model: 'gemini-3.8-flash',
      usage: usage({
        input: 12_727,
        totalOutput: 278,
        cacheWrite: 3,
        cacheRead: 8_151,
        thinking: 201,
        responseOutput: 77,
      }),
      stepIndices: [7, 8],
    }), 1)

    const result = parse()

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
    })
  })

  it('collects retries and deduplicates overlapping generation and step usage', () => {
    const shared = usage({
      input: 100,
      totalOutput: 50,
      cacheRead: 7,
      thinking: 10,
      messageId: 'message-1',
      responseId: 'response-1',
      providerMessageId: 'provider-1',
    })
    const duplicateRetry = usage({
      input: 80,
      totalOutput: 30,
      thinking: 5,
      messageId: 'message-1',
      responseId: 'retry-response',
      providerMessageId: 'provider-1',
    })
    const distinctRetry = usage({
      input: 11,
      totalOutput: 22,
      thinking: 2,
      responseId: 'distinct-retry',
    })
    db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(1, stepMetadata({
      ts: 2_000,
      usage: shared,
      retries: [distinctRetry],
    }))
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, generationMetadata({
      model: 'gemini-2.5-pro',
      usage: shared,
      retries: [duplicateRetry],
      stepIndices: [1],
    }), 1)

    const result = parse()

    expect(result.errors).toEqual([])
    expect(result.records).toHaveLength(2)
    expect(result.records.map((record) => record.inputTokens).sort((a, b) => a - b)).toEqual([11, 100])
    expect(result.records.reduce((sum, record) => sum + record.inputTokens, 0)).toBe(111)
  })

  it('imports usage available only from steps', () => {
    db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(4, stepMetadata({
      ts: 2_000,
      usage: usage({ input: 42, totalOutput: 9 }),
      modelId: 312,
    }))
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, generationMetadata({
      stepIndices: [4],
    }), 1)

    const result = parse()

    expect(result.errors).toEqual([])
    expect(result.nextIndex).toBe(1)
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({ model: 'gemini-2.5-flash', inputTokens: 42, outputTokens: 9 })
  })

  it('parses gen_metadata when the optional steps table is absent', () => {
    db.exec('DROP TABLE steps')
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, generationMetadata({
      model: 'gemini-2.5-flash',
      usage: usage({ input: 20, totalOutput: 5 }),
    }), 1)

    const result = parse()

    expect(result.errors).toEqual([])
    expect(result.records).toHaveLength(1)
    expect(result.nextIndex).toBe(1)
  })

  it('falls back to numeric model IDs when names are unavailable', () => {
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, generationMetadata({
      usage: usage({ modelId: 246, input: 20, totalOutput: 5 }),
    }), 1)

    expect(parse().records[0]).toMatchObject({
      model: 'gemini-2.5-pro',
      provider: 'google',
    })
  })

  it('normalizes Antigravity display labels and routing aliases before pricing', () => {
    const models = [
      ['Gemini 3 Pro', 'gemini-3-pro', 'google'],
      ['Claude Sonnet 4.6 (Thinking)', 'claude-sonnet-4-6', 'anthropic'],
      ['gemini-3-flash-agent', 'gemini-3.5-flash-high', 'google'],
      ['MODEL_PLACEHOLDER_M35', 'claude-sonnet-4-6', 'anthropic'],
    ] as const
    for (const [index, [model]] of models.entries()) {
      db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(index, generationMetadata({
        model,
        usage: usage({ input: 1_000_000, totalOutput: 1, responseId: `response-${index}` }),
      }), 1)
    }

    const records = parse().records

    expect(records).toHaveLength(models.length)
    for (const [index, [, model, provider]] of models.entries()) {
      expect(records[index]).toMatchObject({ model, provider, costSource: 'pricing' })
      expect(records[index].cost).toBeGreaterThan(0)
    }
  })

  it('preserves unknown Antigravity model names', () => {
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, generationMetadata({
      model: 'Future Experimental Model',
      usage: usage({ input: 20, totalOutput: 5 }),
    }), 1)

    expect(parse().records[0]).toMatchObject({
      model: 'Future Experimental Model',
      provider: 'unknown',
      costSource: 'unknown',
    })
  })

  it('resumes from the generation metadata index', () => {
    const data = generationMetadata({
      model: 'gemini-2.5-flash',
      usage: usage({ input: 100, totalOutput: 25, thinking: 5 }),
    })
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, data, data.length)
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(1, data, data.length)

    const result = parse(1)

    expect(result.records.map((record) => record.lineOffset)).toEqual([1])
    expect(result.nextIndex).toBe(2)
  })

  it('advances past an empty generation when a later generation has usage', () => {
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, generationMetadata({}), 0)
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(1, generationMetadata({
      model: 'gemini-2.5-flash',
      usage: usage({ input: 100, totalOutput: 25 }),
    }), 1)

    const result = parse()

    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({ lineOffset: 1, inputTokens: 100 })
    expect(result.nextIndex).toBe(2)
  })

  it('uses the trajectory timestamp before the database mtime fallback', () => {
    const trajectoryTs = Date.UTC(2026, 7, 31, 10, 11, 12, 345)
    db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', trajectoryMetadata(trajectoryTs))
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, generationMetadata({
      model: 'gemini-2.5-flash',
      usage: usage({ input: 20, totalOutput: 5 }),
    }), 1)

    expect(parse().records[0].ts).toBe(trajectoryTs)
  })

  it('prefers generation timestamps over the trajectory timestamp', () => {
    const generationTs = Date.UTC(2026, 8, 1, 1, 2, 3, 456)
    db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', trajectoryMetadata(generationTs - 60_000))
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, generationMetadata({
      model: 'gemini-2.5-flash',
      usage: usage({ input: 20, totalOutput: 5 }),
      ts: generationTs,
    }), 1)

    expect(parse().records[0].ts).toBe(generationTs)
  })

  it('accepts 10-byte varints in generation and step metadata', () => {
    // int64 -1 on the wire: nine 0xff continuation bytes followed by 0x01.
    const negativeOne = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])
    const maxUint64 = Buffer.concat([varint(99 * 8), negativeOne])
    const createdAt = Date.UTC(2026, 8, 6, 14, 19, 29, 321)
    db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(3, Buffer.concat([
      stepMetadata({ ts: createdAt }),
      maxUint64,
    ]))
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, Buffer.concat([
      maxUint64,
      generationMetadata({
        model: 'gemini-3.8-flash',
        usage: usage({ input: 42, totalOutput: 10, thinking: 4, responseOutput: 6 }),
        stepIndices: [3],
      }),
    ]), 1)

    const result = parse()

    expect(result.errors).toEqual([])
    expect(result.nextIndex).toBe(1)
    expect(result.records).toHaveLength(1)
    expect(result.records[0]).toMatchObject({
      ts: createdAt,
      model: 'gemini-3.8-flash',
      inputTokens: 42,
      outputTokens: 6,
      thinkingTokens: 4,
    })
  })

  it('rejects varints longer than 10 bytes', () => {
    const overlong = Buffer.concat([varint(99 * 8), Buffer.alloc(11, 0xff)])
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, Buffer.concat([
      generationMetadata({ model: 'gemini-3.8-flash', usage: usage({ input: 1, totalOutput: 1 }) }),
      overlong,
    ]), 1)

    const result = parse()

    expect(result.records).toEqual([])
    expect(result.errors).toEqual(['generation metadata 0: invalid protobuf varint'])
  })

  it('leaves an unfinished metadata row for a later parse', () => {
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(0, generationMetadata({}), 0)

    const result = parse()

    expect(result.records).toEqual([])
    expect(result.nextIndex).toBe(0)
  })

  describe('model attribution (issue #68)', () => {
    // 4318 stands for an id Antigravity introduced after this parser was written.
    const UNKNOWN_ID = 4318

    it('prefers the readable model over an unknown usage-level model id', () => {
      insertGeneration(0, generationMetadata({
        model: 'gemini-3.8-flash',
        modelId: UNKNOWN_ID,
        label: 'Gemini 3.8 Flash (High)',
        usage: usage({ modelId: UNKNOWN_ID, input: 1_000_000, totalOutput: 10 }),
      }))

      const result = parse()

      expect(result.errors).toEqual([])
      expect(result.records).toHaveLength(1)
      expect(result.records[0]).toMatchObject({ model: 'gemini-3.8-flash', provider: 'google', costSource: 'pricing' })
      expect(result.records[0].cost).toBeGreaterThan(0)
    })

    it('resolves a numeric id from the executor model when the chat model carries no name', () => {
      insertGeneration(0, generationMetadata({
        modelId: UNKNOWN_ID,
        executorModel: 'gemini-3.8-flash-high',
        usage: usage({ modelId: UNKNOWN_ID, input: 1_000_000, totalOutput: 10 }),
      }))

      const [record] = parse().records

      expect(record).toMatchObject({ model: 'gemini-3.8-flash-high', provider: 'google', costSource: 'pricing' })
      expect(record.cost).toBeGreaterThan(0)
    })

    it('falls back to a model-shaped value in the executor_metadata table for the same generation index', () => {
      db.prepare('INSERT INTO executor_metadata (idx, data) VALUES (?, ?)').run(0, executorMetadata('gemini-3.8-flash-high'))
      db.prepare('INSERT INTO executor_metadata (idx, data) VALUES (?, ?)').run(1, executorMetadata('C:/Users/dev/session-42.log'))
      insertGeneration(0, generationMetadata({
        modelId: UNKNOWN_ID,
        usage: usage({ modelId: UNKNOWN_ID, input: 20, totalOutput: 5, responseId: 'r0' }),
      }))
      insertGeneration(1, generationMetadata({
        modelId: UNKNOWN_ID + 1,
        usage: usage({ modelId: UNKNOWN_ID + 1, input: 20, totalOutput: 5, responseId: 'r1' }),
      }))

      const records = parse().records

      expect(records[0]).toMatchObject({ model: 'gemini-3.8-flash-high', provider: 'google' })
      expect(records[1]).toMatchObject({ model: `antigravity-model-${UNKNOWN_ID + 1}`, provider: 'unknown' })
    })

    it('ranks the executor model below the row\'s own label and known id', () => {
      // The executor (field 3 → 28) is not always the chat model: real rows pair
      // a routing-alias slug with a Flash executor. It must neither name the
      // generation nor be learned for the generation's id.
      insertGeneration(0, generationMetadata({
        model: 'gemini-pro-default',
        modelId: 1016,
        label: 'Gemini 3.1 Pro (High)',
        executorModel: 'gemini-3.6-flash-high',
        usage: usage({ modelId: 1016, input: 5_000, totalOutput: 400, responseId: 'r0' }),
      }))
      insertStep(2, stepMetadata({ ts: 2_000, usage: usage({ modelId: 1016, input: 30, totalOutput: 3, responseId: 'r1' }) }))
      insertGeneration(1, generationMetadata({
        model: 'gemini-pro-default',
        modelId: UNKNOWN_ID,
        executorModel: 'gemini-3.6-flash-high',
        usage: usage({ modelId: UNKNOWN_ID, input: 40, totalOutput: 4, responseId: 'r2' }),
        stepIndices: [2],
      }))

      const records = parse().records.map((record) => [record.inputTokens, record.model])

      // Without a label or known id, the executor still beats the routing alias.
      expect(records).toEqual([[5_000, 'gemini-3.1-pro'], [30, 'gemini-3.1-pro'], [40, 'gemini-3.6-flash-high']])
    })

    it('prefers the row\'s own versioned slug over its placeholder when both name the same family', () => {
      insertGeneration(0, generationMetadata({
        model: 'gemini-3.5-flash-high',
        placeholder: 'MODEL_PLACEHOLDER_M20',
        usage: usage({ input: 20, totalOutput: 5, responseId: 'r0' }),
      }))
      insertGeneration(1, generationMetadata({
        model: 'gemini-3.5-flash-low',
        placeholder: 'MODEL_PLACEHOLDER_M187',
        usage: usage({ input: 20, totalOutput: 5, responseId: 'r1' }),
      }))
      insertGeneration(2, generationMetadata({
        model: 'gemini-3.7-flash-safety-le',
        label: 'Gemini 3.7 Flash',
        modelId: 1298,
        usage: usage({ modelId: 1298, input: 20, totalOutput: 5, responseId: 'r2' }),
      }))

      const records = parse().records

      expect(records[0]).toMatchObject({ model: 'gemini-3.5-flash-high', provider: 'google', costSource: 'pricing' })
      // Effort qualifiers are kept as the identity, never collapsed onto another tier.
      expect(records[1]).toMatchObject({ model: 'gemini-3.5-flash-low', provider: 'google' })
      expect(records[2]).toMatchObject({ model: 'gemini-3.7-flash-safety-le', provider: 'google' })
    })

    it('lets the placeholder, label or known id outrank a slug that names another family', () => {
      // Antigravity mints routing-slot names that look versioned; one missing
      // from the routing table must not displace what the row says it ran.
      insertGeneration(0, generationMetadata({
        model: 'gemini-3-flash-d',
        placeholder: 'MODEL_PLACEHOLDER_M132',
        label: 'Gemini 3.5 Flash (High)',
        usage: usage({ input: 20, totalOutput: 5, responseId: 'r0' }),
      }))
      insertGeneration(1, generationMetadata({
        model: 'gemini-4-flash-a',
        label: 'Gemini 3.8 Flash (High)',
        usage: usage({ input: 20, totalOutput: 5, responseId: 'r1' }),
      }))
      insertGeneration(2, generationMetadata({
        model: 'gemini-4-flash-a',
        modelId: 1318,
        usage: usage({ modelId: 1318, input: 20, totalOutput: 5, responseId: 'r2' }),
      }))
      insertGeneration(3, generationMetadata({
        model: 'gemini-4-flash-a',
        usage: usage({ input: 20, totalOutput: 5, responseId: 'r3' }),
      }))

      const records = parse().records.map((record) => record.model)

      // Without any identity to contradict, the slug is still the best name available.
      expect(records).toEqual(['gemini-3.5-flash-high', 'gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-4-flash-a'])
    })

    it('lets a slug refine the row\'s identity but not generalise it or name a routing slot in its family', () => {
      insertGeneration(0, generationMetadata({
        // Less specific than the id's model: Lite must not be billed as Flash.
        model: 'gemini-2.5-flash',
        modelId: 330,
        usage: usage({ modelId: 330, input: 20, totalOutput: 5, responseId: 'r0' }),
      }))
      insertGeneration(1, generationMetadata({
        // A routing slot of the same family still defers to the exact id reference.
        model: 'gemini-3.5-flash-a',
        placeholder: 'MODEL_PLACEHOLDER_M132',
        usage: usage({ input: 20, totalOutput: 5, responseId: 'r1' }),
      }))
      insertGeneration(2, generationMetadata({
        model: 'gemini-2.5-flash-thinking',
        modelId: 312,
        usage: usage({ modelId: 312, input: 20, totalOutput: 5, responseId: 'r2' }),
      }))

      const records = parse().records.map((record) => record.model)

      expect(records).toEqual(['gemini-2.5-flash-lite', 'gemini-3.5-flash-high', 'gemini-2.5-flash-thinking'])
    })

    it('resolves a step\'s model with the same precedence as a generation', () => {
      // A routing alias or an opaque string beside a known id never outranks the
      // id, and never becomes the name every event with that id inherits.
      insertStep(1, stepMetadata({ ts: 1_000, modelId: 1318, modelName: 'gemini-default', usage: usage({ input: 10, totalOutput: 1, responseId: 'r0' }) }))
      insertStep(2, stepMetadata({ ts: 2_000, modelId: 1318, modelName: 'AUTO', usage: usage({ input: 20, totalOutput: 2, responseId: 'r1' }) }))
      insertStep(3, stepMetadata({ ts: 3_000, usage: usage({ modelId: 1318, input: 30, totalOutput: 3, responseId: 'r2' }) }))
      insertGeneration(0, generationMetadata({ stepIndices: [1, 2, 3] }))

      const records = parse().records.map((record) => [record.inputTokens, record.model])

      expect(records).toEqual([[10, 'gemini-3.8-flash'], [20, 'gemini-3.8-flash'], [30, 'gemini-3.8-flash']])
    })

    it('prefers a known id over an owning row that stores no id', () => {
      insertGeneration(0, generationMetadata({
        model: 'gemini-3.8-flash',
        usage: usage({ modelId: 246, input: 20, totalOutput: 5, responseId: 'r0' }),
      }))

      expect(parse().records[0]).toMatchObject({ model: 'gemini-2.5-pro', provider: 'google' })
    })

    it('resolves MODEL_PLACEHOLDER labels through the numeric id table', () => {
      // No numeric id anywhere: only the placeholder can name these rows.
      insertGeneration(0, generationMetadata({
        placeholder: 'MODEL_PLACEHOLDER_M318',
        usage: usage({ input: 20, totalOutput: 5, responseId: 'r0' }),
      }))
      insertGeneration(1, generationMetadata({
        model: 'MODEL_PLACEHOLDER_M16',
        usage: usage({ input: 20, totalOutput: 5, responseId: 'r1' }),
      }))

      const records = parse().records

      expect(records.map((record) => record.model)).toEqual(['gemini-3.8-flash', 'gemini-3.1-pro'])
      expect(records.map((record) => record.provider)).toEqual(['google', 'google'])
    })

    it('never reports an unknown placeholder verbatim and derives its numeric id instead', () => {
      insertGeneration(0, generationMetadata({
        model: 'MODEL_PLACEHOLDER_M999',
        placeholder: 'MODEL_PLACEHOLDER_M999',
        usage: usage({ input: 20, totalOutput: 5 }),
      }))

      expect(parse().records[0]).toMatchObject({ model: 'antigravity-model-1999', provider: 'unknown', costSource: 'unknown' })
    })

    it('lets the row\'s own label or known id outrank a routing alias', () => {
      // A routing alias points at whatever Antigravity's default slot serves today;
      // the label and the numeric id describe what actually ran.
      insertGeneration(0, generationMetadata({
        model: 'gemini-default',
        label: 'Gemini 3.8 Flash (High)',
        usage: usage({ modelId: UNKNOWN_ID, input: 20, totalOutput: 5, responseId: 'r0' }),
      }))
      insertGeneration(1, generationMetadata({
        model: 'gemini-default',
        modelId: 1318,
        usage: usage({ modelId: 1318, input: 20, totalOutput: 5, responseId: 'r1' }),
      }))
      insertGeneration(2, generationMetadata({
        model: 'gemini-default',
        usage: usage({ input: 20, totalOutput: 5, responseId: 'r2' }),
      }))

      const records = parse().records

      expect(records.map((record) => record.model)).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-3.5-flash-medium'])
    })

    it('resolves renamed Claude 4.5 ids to priceable model names', () => {
      insertGeneration(0, generationMetadata({ usage: usage({ modelId: 333, input: 20, totalOutput: 5, responseId: 'r0' }) }))
      insertGeneration(1, generationMetadata({ usage: usage({ modelId: 340, input: 20, totalOutput: 5, responseId: 'r1' }) }))

      const records = parse().records

      expect(records.map((record) => [record.model, record.provider])).toEqual([
        ['claude-sonnet-4-5', 'anthropic'],
        ['claude-haiku-4-5', 'anthropic'],
      ])
    })

    it('prefers a name the database pairs with the id over an owner that has no id', () => {
      insertGeneration(0, generationMetadata({
        model: 'gemini-3.8-flash',
        modelId: UNKNOWN_ID,
        usage: usage({ modelId: UNKNOWN_ID, input: 10, totalOutput: 1, responseId: 'r0' }),
      }))
      // A generation that names its model but stores no id runs two other ids on
      // its steps: one the database names elsewhere, one it never names. Neither
      // step usage is billed to the generation's model; only the generation's own
      // id-less usage is.
      insertStep(3, stepMetadata({ ts: 3_000, usage: usage({ modelId: UNKNOWN_ID, input: 30, totalOutput: 3, responseId: 'helper' }) }))
      insertStep(4, stepMetadata({ ts: 4_000, usage: usage({ modelId: 1050, input: 40, totalOutput: 4, responseId: 'unnamed' }) }))
      insertGeneration(1, generationMetadata({
        model: 'gemini-3.1-pro',
        usage: usage({ input: 20, totalOutput: 2, responseId: 'r1' }),
        stepIndices: [3, 4],
      }))

      const records = parse().records

      expect(records.map((record) => [record.inputTokens, record.model])).toEqual([
        [10, 'gemini-3.8-flash'],
        [30, 'gemini-3.8-flash'],
        [40, 'antigravity-model-1050'],
        [20, 'gemini-3.1-pro'],
      ])
    })

    it('names a numeric id from the rows of the same database that spell it out', () => {
      insertGeneration(0, generationMetadata({
        model: 'gemini-3.8-flash',
        modelId: UNKNOWN_ID,
        usage: usage({ modelId: UNKNOWN_ID, input: 10, totalOutput: 1, responseId: 'r0' }),
      }))
      // A later generation on another model runs a step on the unknown id without naming it.
      insertStep(3, stepMetadata({ ts: 3_000, usage: usage({ modelId: UNKNOWN_ID, input: 30, totalOutput: 3, responseId: 'r-step' }) }))
      insertGeneration(1, generationMetadata({
        model: 'gemini-2.5-pro',
        modelId: 246,
        usage: usage({ modelId: 246, input: 20, totalOutput: 2, responseId: 'r1' }),
        stepIndices: [3],
      }))

      const records = parse().records

      expect(records.map((record) => [record.inputTokens, record.model])).toEqual([
        [10, 'gemini-3.8-flash'],
        [30, 'gemini-3.8-flash'],
        [20, 'gemini-2.5-pro'],
      ])
    })

    it('keeps a genuinely unknown id as a placeholder instead of borrowing the generation model', () => {
      // Antigravity runs a helper model (id 1050) inside conversations driven by another model.
      insertStep(2, stepMetadata({ ts: 2_000, usage: usage({ modelId: 1050, input: 70, totalOutput: 6, responseId: 'helper' }) }))
      insertGeneration(0, generationMetadata({
        model: 'gemini-pro-default',
        modelId: 1016,
        label: 'Gemini 3.1 Pro (High)',
        usage: usage({ modelId: 1016, input: 5_000, totalOutput: 400, responseId: 'main' }),
        stepIndices: [2],
      }))

      const records = parse().records.sort((a, b) => a.inputTokens - b.inputTokens)

      expect(records).toHaveLength(2)
      expect(records[0]).toMatchObject({ model: 'antigravity-model-1050', provider: 'unknown', cost: 0, costSource: 'unknown' })
      expect(records[1]).toMatchObject({ model: 'gemini-3.1-pro', provider: 'google' })
    })

    it('does not let deduplication borrow the readable model or counters of a copy with another id', () => {
      // The step and generation rows describe the same response but disagree on
      // its model id. The step copy is seen first and is kept whole: neither the
      // generation copy's name nor its larger token counts may be billed to the
      // helper model's id.
      insertStep(1, stepMetadata({
        ts: 1_000,
        usage: usage({ modelId: 1050, input: 70, totalOutput: 6, responseId: 'shared', providerMessageId: 'provider-1' }),
      }))
      insertGeneration(0, generationMetadata({
        model: 'gemini-pro-default',
        modelId: 1016,
        label: 'Gemini 3.1 Pro (High)',
        usage: usage({ modelId: 1016, input: 90, totalOutput: 8, cacheRead: 5, responseId: 'shared', providerMessageId: 'provider-1' }),
        stepIndices: [1],
      }))

      const result = parse()

      expect(result.errors).toEqual([])
      expect(result.records).toHaveLength(1)
      expect(result.records[0]).toMatchObject({
        model: 'antigravity-model-1050',
        provider: 'unknown',
        costSource: 'unknown',
        inputTokens: 70,
        outputTokens: 6,
        cacheReadTokens: 0,
      })
    })

    it('keeps the generation copy whole when a later step repeats its response under another id', () => {
      insertGeneration(0, generationMetadata({
        model: 'gemini-pro-default',
        modelId: 1016,
        label: 'Gemini 3.1 Pro (High)',
        usage: usage({ modelId: 1016, input: 5_000, totalOutput: 400, responseId: 'shared' }),
      }))
      insertStep(3, stepMetadata({
        ts: 3_000,
        usage: usage({ modelId: 1050, input: 9_000, totalOutput: 900, responseId: 'shared' }),
      }))
      insertGeneration(1, generationMetadata({ stepIndices: [3] }))

      const result = parse()

      expect(result.errors).toEqual([])
      expect(result.records).toHaveLength(1)
      expect(result.records[0]).toMatchObject({ model: 'gemini-3.1-pro', provider: 'google', inputTokens: 5_000, outputTokens: 400 })
    })

    it('re-emits usage imported earlier once a later row names its id', () => {
      // Generation 0 runs an id nothing names yet; the first import records it
      // as a placeholder. A later generation's step then stores the name.
      insertGeneration(0, generationMetadata({
        usage: usage({ modelId: UNKNOWN_ID, input: 10, totalOutput: 1, responseId: 'r0' }),
      }))
      const [first] = parse().records
      expect(first).toMatchObject({ model: `antigravity-model-${UNKNOWN_ID}`, provider: 'unknown' })

      insertStep(3, stepMetadata({
        ts: 3_000,
        modelId: UNKNOWN_ID,
        modelName: 'gemini-3.8-flash',
        usage: usage({ input: 30, totalOutput: 3, responseId: 'r1' }),
      }))
      insertGeneration(1, generationMetadata({ stepIndices: [3] }))

      const incremental = parse(1)
      const full = parse()

      expect(incremental.errors).toEqual([])
      expect(incremental.nextIndex).toBe(2)
      expect(incremental.records.map((record) => [record.inputTokens, record.model])).toEqual([[10, 'gemini-3.8-flash'], [30, 'gemini-3.8-flash']])
      // The corrected record replaces the placeholder one: same id, new model,
      // and the same timestamp (a row-index fallback here) as a full import.
      expect(incremental.records[0].id).toBe(first.id)
      expect(incremental.records[0].ts).toBe(first.ts)
      expect(full.records.map((record) => [record.id, record.model, record.ts])).toEqual(incremental.records.map((record) => [record.id, record.model, record.ts]))
    })

    it('re-emits earlier id-less usage once the database gets its first named generation', () => {
      insertGeneration(0, generationMetadata({ usage: usage({ input: 10, totalOutput: 1, responseId: 'r0' }) }))
      const [first] = parse().records
      expect(first).toMatchObject({ model: 'antigravity-unknown' })

      insertGeneration(1, generationMetadata({ model: 'gemini-3.8-flash', usage: usage({ input: 30, totalOutput: 3, responseId: 'r1' }) }))

      const incremental = parse(1)
      const full = parse()

      expect(incremental.records.map((record) => [record.id, record.model])).toEqual([[first.id, 'gemini-3.8-flash'], [incremental.records[1].id, 'gemini-3.8-flash']])
      expect(full.records.map((record) => [record.id, record.model])).toEqual(incremental.records.map((record) => [record.id, record.model]))
    })

    it('re-emits earlier id-less usage when the last named generation is processed after being held back', () => {
      insertGeneration(0, generationMetadata({ usage: usage({ input: 10, totalOutput: 1, responseId: 'r0' }) }))
      const [first] = parse().records
      expect(first).toMatchObject({ model: 'antigravity-unknown' })

      insertGeneration(1, generationMetadata({ model: 'gemini-2.5-pro', usage: usage({ input: 20, totalOutput: 2, responseId: 'r1' }) }))
      // The latest generation names a model but has no usage yet: held back.
      insertGeneration(2, generationMetadata({ model: 'gemini-3.8-flash' }))
      const heldBack = parse(1)
      expect(heldBack.nextIndex).toBe(2)
      // Until then the last named generation is generation 1, which names the
      // id-less usage for now, exactly as a full import would.
      expect(heldBack.records.map((record) => [record.inputTokens, record.model])).toEqual([[10, 'gemini-2.5-pro'], [20, 'gemini-2.5-pro']])
      expect(parse().records.map((record) => [record.inputTokens, record.model])).toEqual([[10, 'gemini-2.5-pro'], [20, 'gemini-2.5-pro']])

      db.prepare('UPDATE gen_metadata SET data = ? WHERE idx = 2').run(generationMetadata({
        model: 'gemini-3.8-flash',
        usage: usage({ input: 30, totalOutput: 3, responseId: 'r2' }),
      }))
      const incremental = parse(2)
      const full = parse()

      // The id-less usage takes its name from the last named generation, so it
      // is corrected once that generation is processed, as a full import would.
      expect(incremental.records.map((record) => [record.id, record.model])).toEqual([[first.id, 'gemini-3.8-flash'], [incremental.records[1].id, 'gemini-3.8-flash']])
      expect(full.records.map((record) => [record.id, record.model])).toEqual([[first.id, 'gemini-3.8-flash'], [heldBack.records[1].id, 'gemini-2.5-pro'], [incremental.records[1].id, 'gemini-3.8-flash']])
    })

    it('merges a new copy of an earlier response with the earlier copy as a full import would', () => {
      // The earlier step copy runs the helper model; a later generation stores
      // the same response under an id it names. A full import keeps the step
      // copy whole, so the incremental import must write that same record.
      insertStep(1, stepMetadata({ ts: 1_000, usage: usage({ modelId: 1050, input: 70, totalOutput: 6, responseId: 'shared' }) }))
      insertGeneration(0, generationMetadata({ stepIndices: [1] }))
      const [first] = parse().records
      expect(first).toMatchObject({ model: 'antigravity-model-1050', inputTokens: 70 })

      insertGeneration(1, generationMetadata({
        model: 'gemini-8.8-flash',
        modelId: UNKNOWN_ID,
        usage: usage({ modelId: UNKNOWN_ID, input: 90, totalOutput: 8, responseId: 'shared' }),
      }))

      const incremental = parse(1)
      const full = parse()

      expect(incremental.records.map((record) => [record.id, record.model, record.inputTokens])).toEqual([[first.id, 'antigravity-model-1050', 70]])
      expect(full.records.map((record) => [record.id, record.model, record.inputTokens])).toEqual([[first.id, 'antigravity-model-1050', 70]])
    })

    it('gives a step its placeholder-derived id so a conflicting copy is not merged into it', () => {
      insertStep(1, stepMetadata({ ts: 1_000, modelName: 'MODEL_PLACEHOLDER_M318', usage: usage({ input: 70, totalOutput: 6, responseId: 'shared' }) }))
      insertGeneration(0, generationMetadata({
        modelId: UNKNOWN_ID,
        usage: usage({ modelId: UNKNOWN_ID, input: 90, totalOutput: 8, responseId: 'shared' }),
        stepIndices: [1],
      }))

      const records = parse().records

      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ model: 'gemini-3.8-flash', inputTokens: 70, outputTokens: 6 })
    })

    it('attributes an id to the same row whether the import is full or incremental', () => {
      // A step an earlier import covered and a generation this import adds both
      // store a name beside the id; a full import lets the generation name it
      // (generations precede steps), so an incremental import must too.
      insertStep(1, stepMetadata({ ts: 1_000, modelId: UNKNOWN_ID, modelName: 'gemini-9.9-flash', usage: usage({ input: 10, totalOutput: 1, responseId: 'r0' }) }))
      insertGeneration(0, generationMetadata({ model: 'gemini-2.5-pro', modelId: 246, stepIndices: [1] }))
      expect(parse().nextIndex).toBe(1)

      insertGeneration(1, generationMetadata({
        model: 'gemini-8.8-flash',
        modelId: UNKNOWN_ID,
        usage: usage({ modelId: UNKNOWN_ID, input: 20, totalOutput: 2, responseId: 'r1' }),
      }))
      insertStep(3, stepMetadata({ ts: 3_000, usage: usage({ modelId: UNKNOWN_ID, input: 40, totalOutput: 4, responseId: 'r3' }) }))
      insertGeneration(2, generationMetadata({ model: 'gemini-7.7-pro', modelId: 777, stepIndices: [3] }))

      const incremental = parse(1)
      const full = parse()

      const byId = (records: typeof full.records) => new Map(records.map((record) => [record.id, record.model]))
      expect(incremental.records.find((record) => record.inputTokens === 40)).toMatchObject({ model: 'gemini-8.8-flash' })
      for (const [id, model] of byId(incremental.records)) expect(byId(full.records).get(id)).toBe(model)
    })

    it('re-emits earlier usage named by a step even when the cursor later moves back below it', () => {
      insertStep(20, stepMetadata({ ts: 20_000, usage: usage({ modelId: UNKNOWN_ID, input: 20, totalOutput: 2, responseId: 'r20' }) }))
      insertStep(30, stepMetadata({ ts: 30_000, usage: usage({ modelId: UNKNOWN_ID, input: 30, totalOutput: 3, responseId: 'r30' }) }))
      insertGeneration(0, generationMetadata({ stepIndices: [30] }))
      expect(parse().records.map((record) => record.model)).toEqual([`antigravity-model-${UNKNOWN_ID}`, `antigravity-model-${UNKNOWN_ID}`])

      insertStep(31, stepMetadata({ ts: 31_000, modelId: UNKNOWN_ID, modelName: 'gemini-9.9-flash', usage: usage({ input: 31, totalOutput: 3, responseId: 'r31' }) }))
      insertGeneration(1, generationMetadata({ stepIndices: [31] }))
      insertStep(5, stepMetadata({ ts: 5_000, usage: usage({ input: 5, totalOutput: 1, responseId: 'r5' }) }))
      insertGeneration(2, generationMetadata({ stepIndices: [5], usage: usage({ input: 2, totalOutput: 1, responseId: 'r2' }) }))
      insertStep(6, stepMetadata({ ts: 6_000, usage: usage({ input: 6, totalOutput: 1, responseId: 'r6' }) }))
      insertGeneration(3, generationMetadata({ stepIndices: [6] }))

      const incremental = parse(1)
      const full = parse()

      expect(incremental.records.filter((record) => [20, 30].includes(record.inputTokens)).map((record) => record.model))
        .toEqual(['gemini-9.9-flash', 'gemini-9.9-flash'])
      // Step 5 was written for generation 2 but falls into generation 0's
      // window; it is still new to this import and must be recorded.
      expect(incremental.records.map((record) => record.inputTokens).sort((a, b) => a - b)).toEqual([2, 5, 6, 20, 30, 31])
      expect(full.records.map((record) => record.inputTokens).sort((a, b) => a - b)).toEqual([2, 5, 6, 20, 30, 31])
      const byId = (records: typeof full.records) => new Map(records.map((record) => [record.id, record.model]))
      for (const [id, model] of byId(incremental.records)) expect(byId(full.records).get(id)).toBe(model)
    })

    it('keeps the copy a full import keeps when re-emitting a response two earlier rows stored under different ids', () => {
      // The step copy (helper id) and the generation copy (another unknown id)
      // share a response; a full import keeps the step copy. Naming the
      // generation's id later must not swap the record to the generation copy.
      insertStep(1, stepMetadata({ ts: 1_000, usage: usage({ modelId: 1050, input: 70, totalOutput: 6, responseId: 'shared' }) }))
      insertGeneration(0, generationMetadata({
        modelId: UNKNOWN_ID,
        usage: usage({ modelId: UNKNOWN_ID, input: 90, totalOutput: 8, responseId: 'shared' }),
        stepIndices: [1],
      }))
      const [first] = parse().records
      expect(first).toMatchObject({ model: 'antigravity-model-1050', inputTokens: 70 })

      insertStep(3, stepMetadata({ ts: 3_000, modelId: UNKNOWN_ID, modelName: 'gemini-3.8-flash', usage: usage({ input: 30, totalOutput: 3, responseId: 'r1' }) }))
      insertGeneration(1, generationMetadata({ stepIndices: [3] }))

      const incremental = parse(1)
      const full = parse()

      expect(incremental.records.map((record) => [record.model, record.inputTokens])).toEqual([['gemini-3.8-flash', 30]])
      expect(full.records.map((record) => [record.id, record.model, record.inputTokens])).toEqual([[first.id, 'antigravity-model-1050', 70], [incremental.records[0].id, 'gemini-3.8-flash', 30]])
    })

    it('does not re-emit earlier usage for a name only an unfinished latest generation gives', () => {
      insertGeneration(0, generationMetadata({ usage: usage({ modelId: UNKNOWN_ID, input: 10, totalOutput: 1, responseId: 'r0' }) }))
      expect(parse().records[0]).toMatchObject({ model: `antigravity-model-${UNKNOWN_ID}` })

      // The latest generation names the id but carries no usage yet, so it is
      // held back for a later parse; nothing is corrected until then, and a
      // full import of the same database agrees.
      insertGeneration(1, generationMetadata({ model: 'gemini-3.8-flash', modelId: UNKNOWN_ID }))

      const result = parse(1)
      const full = parse()

      expect(result.records).toEqual([])
      expect(result.nextIndex).toBe(1)
      expect(full.records.map((record) => record.model)).toEqual([`antigravity-model-${UNKNOWN_ID}`])
      expect(full.nextIndex).toBe(1)
    })

    it('imports a latest generation whose only usage is in a step an earlier window covers', () => {
      insertStep(30, stepMetadata({ ts: 30_000, usage: usage({ input: 30, totalOutput: 3, responseId: 'r30' }) }))
      insertGeneration(0, generationMetadata({ model: 'gemini-3.8-flash', stepIndices: [30] }))
      expect(parse().nextIndex).toBe(1)

      // The new generation links a lower step index, so its own window is
      // empty; the step it links still carries its usage and must import now.
      insertStep(5, stepMetadata({ ts: 5_000, usage: usage({ input: 5, totalOutput: 1, responseId: 'r5' }) }))
      insertGeneration(1, generationMetadata({ model: 'gemini-3.8-flash', stepIndices: [5] }))

      const incremental = parse(1)
      const full = parse()

      expect(incremental.nextIndex).toBe(2)
      expect(incremental.records.map((record) => [record.inputTokens, record.model])).toEqual([[5, 'gemini-3.8-flash']])
      expect(full.records.map((record) => record.inputTokens).sort((a, b) => a - b)).toEqual([5, 30])
    })

    it('ignores a placeholder slug or step name that contradicts an unknown explicit id', () => {
      insertGeneration(0, generationMetadata({
        model: 'MODEL_PLACEHOLDER_M318',
        modelId: UNKNOWN_ID,
        usage: usage({ input: 20, totalOutput: 5, responseId: 'r0' }),
      }))
      insertStep(2, stepMetadata({
        ts: 2_000,
        modelId: UNKNOWN_ID,
        modelName: 'MODEL_PLACEHOLDER_M318',
        usage: usage({ input: 30, totalOutput: 3, responseId: 'r1' }),
      }))
      insertGeneration(1, generationMetadata({ stepIndices: [2] }))

      const records = parse().records.map((record) => record.model)

      expect(records).toEqual([`antigravity-model-${UNKNOWN_ID}`, `antigravity-model-${UNKNOWN_ID}`])
    })

    it('does not re-emit earlier usage whose id was already named before this import', () => {
      insertStep(1, stepMetadata({
        ts: 1_000,
        modelId: UNKNOWN_ID,
        modelName: 'gemini-3.8-flash',
        usage: usage({ input: 10, totalOutput: 1, responseId: 'r0' }),
      }))
      insertGeneration(0, generationMetadata({ stepIndices: [1] }))
      insertStep(2, stepMetadata({ ts: 2_000, modelId: UNKNOWN_ID, modelName: 'gemini-3.8-flash', usage: usage({ input: 30, totalOutput: 3, responseId: 'r1' }) }))
      insertGeneration(1, generationMetadata({ stepIndices: [2] }))

      expect(parse(1).records.map((record) => [record.inputTokens, record.model])).toEqual([[30, 'gemini-3.8-flash']])
    })

    it('ignores a placeholder that contradicts the row\'s explicit id', () => {
      insertGeneration(0, generationMetadata({
        modelId: 1016,
        placeholder: 'MODEL_PLACEHOLDER_M318',
        usage: usage({ input: 20, totalOutput: 5, responseId: 'r0' }),
      }))

      const [record] = parse().records

      // The usage is stamped with id 1016, so it is billed as that id's model, not as Flash.
      expect(record).toMatchObject({ model: 'gemini-3.1-pro', provider: 'google' })
    })

    it('names an id from steps an earlier import already covered', () => {
      // A step before the cursor is the only row that names the id; an
      // incremental import must attribute later usage exactly like a full one.
      insertStep(1, stepMetadata({
        ts: 1_000,
        modelId: UNKNOWN_ID,
        modelName: 'gemini-3.8-flash',
        usage: usage({ modelId: UNKNOWN_ID, input: 10, totalOutput: 1, responseId: 'r0' }),
      }))
      insertGeneration(0, generationMetadata({ stepIndices: [1] }))
      insertStep(2, stepMetadata({ ts: 2_000, usage: usage({ modelId: UNKNOWN_ID, input: 30, totalOutput: 3, responseId: 'r1' }) }))
      insertGeneration(1, generationMetadata({ stepIndices: [2] }))

      const full = parse().records.map((record) => [record.inputTokens, record.model])
      const incremental = parse(1).records.map((record) => [record.inputTokens, record.model])

      expect(full).toEqual([[10, 'gemini-3.8-flash'], [30, 'gemini-3.8-flash']])
      expect(incremental).toEqual([[30, 'gemini-3.8-flash']])
    })

    it('names a row from a table only until another row stores a name beside the same id', () => {
      db.prepare('INSERT INTO executor_metadata (idx, data) VALUES (?, ?)').run(0, executorMetadata('gemini-3.8-flash-high'))
      insertGeneration(0, generationMetadata({
        modelId: UNKNOWN_ID,
        usage: usage({ modelId: UNKNOWN_ID, input: 10, totalOutput: 1, responseId: 'r0' }),
      }))
      // A later generation on another model runs the unknown id on two steps:
      // one names it, one carries only the id.
      insertStep(3, stepMetadata({
        ts: 3_000,
        modelId: UNKNOWN_ID,
        modelName: 'gemini-3.8-flash',
        usage: usage({ input: 20, totalOutput: 2, responseId: 'r1' }),
      }))
      insertStep(4, stepMetadata({ ts: 4_000, usage: usage({ modelId: UNKNOWN_ID, input: 30, totalOutput: 3, responseId: 'r2' }) }))
      insertGeneration(1, generationMetadata({
        model: 'gemini-2.5-pro',
        modelId: 246,
        usage: usage({ modelId: 246, input: 40, totalOutput: 4, responseId: 'r3' }),
        stepIndices: [3, 4],
      }))

      const records = parse().records.map((record) => [record.inputTokens, record.model])

      // The step row stores a name beside the id, so the id carries that one name
      // throughout the database, including on the generation that was only
      // named from the executor_metadata table.
      expect(records).toEqual([
        [10, 'gemini-3.8-flash'],
        [20, 'gemini-3.8-flash'],
        [30, 'gemini-3.8-flash'],
        [40, 'gemini-2.5-pro'],
      ])
    })

    it('lets deduplication adopt the readable model of a copy whose id is compatible', () => {
      insertStep(1, stepMetadata({
        ts: 1_000,
        usage: usage({ input: 70, totalOutput: 6, responseId: 'shared' }),
      }))
      insertGeneration(0, generationMetadata({
        model: 'gemini-pro-default',
        modelId: 1016,
        label: 'Gemini 3.1 Pro (High)',
        usage: usage({ modelId: 1016, input: 90, totalOutput: 6, responseId: 'shared' }),
        stepIndices: [1],
      }))

      const result = parse()

      expect(result.errors).toEqual([])
      expect(result.records).toHaveLength(1)
      expect(result.records[0]).toMatchObject({ model: 'gemini-3.1-pro', provider: 'google', inputTokens: 90 })
    })

    it('prefers the copy whose readable model is paired with the merged id over an id-less assumption', () => {
      // The step copy carries no id and inherits the conversation model as a
      // last resort; the generation copy of the same response names its own id.
      insertStep(1, stepMetadata({
        ts: 1_000,
        usage: usage({ input: 70, totalOutput: 6, responseId: 'shared' }),
      }))
      insertStep(2, stepMetadata({
        ts: 2_000,
        modelId: 1050,
        modelName: 'gemini-3.5-flash',
        usage: usage({ modelId: 1050, input: 90, totalOutput: 6, responseId: 'shared' }),
      }))
      insertGeneration(0, generationMetadata({
        model: 'gemini-pro-default',
        modelId: 1016,
        label: 'Gemini 3.1 Pro (High)',
        usage: usage({ modelId: 1016, input: 5_000, totalOutput: 400, responseId: 'main' }),
        stepIndices: [1, 2],
      }))

      const records = parse().records.sort((a, b) => a.inputTokens - b.inputTokens)

      expect(records).toHaveLength(2)
      expect(records[0]).toMatchObject({ model: 'gemini-3.5-flash', inputTokens: 90 })
      expect(records[1]).toMatchObject({ model: 'gemini-3.1-pro', inputTokens: 5_000 })
    })

    it('inherits the step model only for events whose id matches the step', () => {
      insertStep(1, stepMetadata({
        ts: 1_000,
        modelId: 1016,
        modelName: 'gemini-3.1-pro',
        // The step's own usage carries no id and inherits the step's; the helper
        // model's usage names a different id and must not be billed as Gemini 3.1 Pro.
        usage: usage({ input: 5_000, totalOutput: 400, responseId: 'main' }),
      }))
      insertStep(2, stepMetadata({
        ts: 2_000,
        modelId: 1016,
        modelName: 'gemini-3.1-pro',
        usage: usage({ modelId: 1050, input: 70, totalOutput: 6, responseId: 'helper' }),
      }))
      insertGeneration(0, generationMetadata({ stepIndices: [1, 2] }))

      const records = parse().records.sort((a, b) => a.inputTokens - b.inputTokens)

      expect(records).toHaveLength(2)
      expect(records[0]).toMatchObject({ model: 'antigravity-model-1050', provider: 'unknown', costSource: 'unknown' })
      expect(records[1]).toMatchObject({ model: 'gemini-3.1-pro', provider: 'google' })
    })

    it('does not let a retry on another model inherit the step model', () => {
      insertStep(1, stepMetadata({
        ts: 1_000,
        modelId: 1016,
        modelName: 'gemini-3.1-pro',
        usage: usage({ modelId: 1016, input: 5_000, totalOutput: 400, responseId: 'main' }),
        retries: [usage({ modelId: 1050, input: 70, totalOutput: 6, responseId: 'retry' })],
      }))
      insertGeneration(0, generationMetadata({ stepIndices: [1] }))

      const records = parse().records.sort((a, b) => a.inputTokens - b.inputTokens)

      expect(records).toHaveLength(2)
      expect(records[0]).toMatchObject({ model: 'antigravity-model-1050', provider: 'unknown', inputTokens: 70 })
      expect(records[1]).toMatchObject({ model: 'gemini-3.1-pro', provider: 'google', inputTokens: 5_000 })
    })

    it('inherits the readable step model when the usage id matches the step id', () => {
      insertStep(1, stepMetadata({
        ts: 1_000,
        modelId: UNKNOWN_ID,
        modelName: 'gemini-3.8-flash',
        usage: usage({ modelId: UNKNOWN_ID, input: 12, totalOutput: 3, responseId: 'main' }),
        retries: [usage({ modelId: UNKNOWN_ID, input: 8, totalOutput: 2, responseId: 'retry' })],
      }))
      insertGeneration(0, generationMetadata({ stepIndices: [1] }))

      const records = parse().records

      expect(records).toHaveLength(2)
      expect(records.map((record) => record.model)).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash'])
    })

    it('does not let an unknown step model id override the step model name', () => {
      insertStep(1, stepMetadata({
        ts: 1_000,
        modelId: UNKNOWN_ID,
        modelName: 'gemini-3.8-flash',
        usage: usage({ input: 12, totalOutput: 3 }),
      }))
      insertGeneration(0, generationMetadata({ stepIndices: [1] }))

      expect(parse().records[0]).toMatchObject({ model: 'gemini-3.8-flash', provider: 'google' })
    })

    it('slugifies Gemini display labels without their effort qualifier when no slug is stored', () => {
      insertGeneration(0, generationMetadata({
        label: 'Gemini 3.5 Flash (Medium)',
        usage: usage({ modelId: UNKNOWN_ID, input: 20, totalOutput: 5, responseId: 'r0' }),
      }))
      insertGeneration(1, generationMetadata({
        label: 'Gemini 4 Pro',
        usage: usage({ modelId: UNKNOWN_ID + 1, input: 20, totalOutput: 5, responseId: 'r1' }),
      }))

      expect(parse().records.map((record) => record.model)).toEqual(['gemini-3.5-flash', 'gemini-4-pro'])
    })

    it('keeps record ids stable when the model attribution changes', () => {
      const shared = usage({ modelId: UNKNOWN_ID, input: 20, totalOutput: 5, responseId: 'stable-response' })
      insertGeneration(0, generationMetadata({ usage: shared }))
      const corrected = new Database(':memory:')
      corrected.exec(SCHEMA)
      corrected.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
        .run(0, generationMetadata({ model: 'gemini-3.8-flash', modelId: UNKNOWN_ID, usage: shared }), 1)

      try {
        const [before] = parse().records
        const [after] = parse(0, corrected).records

        expect(before.model).toBe(`antigravity-model-${UNKNOWN_ID}`)
        expect(after.model).toBe('gemini-3.8-flash')
        expect(after.id).toBe(before.id)
      } finally {
        corrected.close()
      }
    })
  })

  it('preserves effort-qualified Gemini Pro variants as the model identity (issue #69)', () => {
    for (const [index, model] of ['gemini-3.1-pro', 'gemini-3.1-pro-high', 'gemini-3.1-pro-low'].entries()) {
      insertGeneration(index, generationMetadata({
        model,
        usage: usage({ input: 20, totalOutput: 5, responseId: `response-${index}` }),
      }))
    }

    const records = parse().records

    expect(records.map((record) => record.model)).toEqual(['gemini-3.1-pro', 'gemini-3.1-pro-high', 'gemini-3.1-pro-low'])
    expect(records.every((record) => record.provider === 'google')).toBe(true)
  })
})
