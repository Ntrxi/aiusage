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

interface ModelUsage {
  modelId?: number
  inputTokens: number
  totalOutputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  thinkingTokens: number
  outputTokens: number
  identities: string[]
}

interface UsageEvent {
  usage: ModelUsage
  /**
   * Readable model that describes this event: read from the event's own
   * metadata, or inherited from its generation when the generation's numeric
   * model id matches the event's (or either side carries no id).
   */
  model?: string
  ts?: number
  sourceKey: string
  lineOffset: number
}

/** A readable model name together with the numeric model id it was stored next to. */
interface NamedModel {
  model?: string
  modelId?: number
}

interface GenerationMetadata extends NamedModel {
  index: number
  stepIndices: number[]
  events: UsageEvent[]
}

interface StepMetadata extends NamedModel {
  ts?: number
  events: UsageEvent[]
}

// A protobuf varint carries at most 64 bits, which is 10 base-128 bytes.
// Negative int64/int32 values (for example -1 sentinels) always use all 10.
const MAX_VARINT_BYTES = 10

function readVarint(data: Buffer, start: number): { value: number; offset: number } {
  let value = 0
  let shift = 0
  let offset = start
  while (offset < data.length && offset - start < MAX_VARINT_BYTES) {
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
    } else if (wireType === 1) {
      if (offset + 8 > data.length) throw new Error('truncated protobuf fixed64')
      fields.push({ number, wireType, value: data.subarray(offset, offset + 8) })
      offset += 8
    } else if (wireType === 2) {
      const size = readVarint(data, offset)
      const end = size.offset + size.value
      if (end > data.length) throw new Error('truncated protobuf bytes')
      fields.push({ number, wireType, value: data.subarray(size.offset, end) })
      offset = end
    } else if (wireType === 5) {
      if (offset + 4 > data.length) throw new Error('truncated protobuf fixed32')
      fields.push({ number, wireType, value: data.subarray(offset, offset + 4) })
      offset += 4
    } else {
      throw new Error(`unsupported protobuf wire type ${wireType}`)
    }
  }
  return fields
}

function messages(fields: ProtoField[], number: number): ProtoField[][] {
  return fields
    .filter((field) => field.number === number && field.wireType === 2 && Buffer.isBuffer(field.value))
    .map((field) => readFields(field.value as Buffer))
}

function firstMessage(fields: ProtoField[], number: number): ProtoField[] {
  return messages(fields, number)[0] ?? []
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

function timestampFromFields(fields: ProtoField[]): number | undefined {
  const seconds = firstVarint(fields, 1)
  if (seconds == null || seconds <= 0) return undefined
  const nanos = Math.min(firstVarint(fields, 2) ?? 0, 999_999_999)
  return seconds * 1000 + Math.floor(nanos / 1_000_000)
}

function generationTimestamp(chatModel: ProtoField[]): number | undefined {
  const generationInfo = firstMessage(chatModel, 9)
  return timestampFromFields(firstMessage(generationInfo, 4))
}

const ANTIGRAVITY_MODEL_ALIASES: Record<string, string> = {
  'gemini 3.8 flash': 'gemini-3.8-flash',
  'gemini 3.7 flash': 'gemini-3.7-flash',
  'gemini 3.7 flash thinking': 'gemini-3.7-flash',
  'gemini 3.7 pro': 'gemini-3.7-pro',
  'gemini 3.7 pro thinking': 'gemini-3.7-pro',
  'gemini 3.6 flash': 'gemini-3.6-flash',
  'gemini 3 flash': 'gemini-3.6-flash',
  'gemini 3.6 pro': 'gemini-3.6-pro',
  'gemini 3 pro': 'gemini-3-pro',
  'gemini 3 pro thinking': 'gemini-3-pro',
  'gemini 2.5 flash': 'gemini-2.5-flash',
  'gemini 2.5 pro': 'gemini-2.5-pro',
  'gemini 2.0 flash': 'gemini-2.0-flash',
  'gemini 2 flash': 'gemini-2.0-flash',
  'gemini 2.0 pro': 'gemini-2.0-pro',
  'gemini 1.5 flash': 'gemini-1.5-flash',
  'gemini 1.5 pro': 'gemini-1.5-pro',
  'claude opus 4.6': 'claude-opus-4-6',
  'claude 4.6 opus': 'claude-opus-4-6',
  'claude sonnet 4.6': 'claude-sonnet-4-6',
  'claude 4.6 sonnet': 'claude-sonnet-4-6',
  'claude sonnet 4.5': 'claude-sonnet-4-5',
  'claude 3.7 sonnet': 'claude-3-7-sonnet',
  'claude 3.7 sonnet thinking': 'claude-3-7-sonnet',
  'claude 3.5 sonnet': 'claude-3-5-sonnet',
  'claude 3.5 haiku': 'claude-3-5-haiku',
  'claude 3 opus': 'claude-3-opus',
  'gpt-oss 120b': 'gpt-oss-120b-medium',
  'model_placeholder_m26': 'claude-opus-4-6',
  'model_placeholder_m35': 'claude-sonnet-4-6',
  'model_placeholder_m16': 'gemini-3.1-pro',
  'model_placeholder_m36': 'gemini-3.1-pro',
  'model_placeholder_m37': 'gemini-3.1-pro',
  'model_placeholder_m18': 'gemini-3-flash-preview',
  'model_placeholder_m47': 'gemini-3-flash-preview',
  'model_placeholder_m84': 'gemini-3-flash-preview',
  'model_placeholder_m20': 'gemini-3.5-flash-medium',
  'model_placeholder_m132': 'gemini-3.5-flash-high',
  'model_placeholder_m133': 'gemini-3.5-flash-high',
  'model_placeholder_m187': 'gemini-3.5-flash-extra-low',
  'model_openai_gpt_oss_120b_medium': 'gpt-oss-120b-medium',
  'claude-opus-4-6-thinking': 'claude-opus-4-6',
  'gemini-default': 'gemini-3.5-flash-medium',
  'gemini-pro-default': 'gemini-3.1-pro',
  'gemini-pro-agent': 'gemini-3.1-pro',
  'gemini-3-flash-agent': 'gemini-3.5-flash-high',
  'gemini-3-flash-agent-a': 'gemini-3.5-flash-high',
  'gemini-3-flash-agent-b': 'gemini-3.5-flash-high',
  'gemini-3-flash-a': 'gemini-3.5-flash-high',
  'gemini-3-flash-b': 'gemini-3.5-flash-high',
  'gemini-3-flash-c': 'gemini-3-flash-preview',
  'gemini-3-flash': 'gemini-3-flash-preview',
  'gemini-3.5-flash-low': 'gemini-3.5-flash-medium',
}

/**
 * Numeric model ids observed in Antigravity databases, kept only as a fallback
 * for rows that carry no readable model. Antigravity's `MODEL_PLACEHOLDER_M<n>`
 * labels denote the model with id `1000 + n`, so the two tables bridge each other.
 * Effort-qualified Gemini 3.x Pro names (`-high`, `-low`) are kept as the model
 * identity; pricing maps them onto the same registry entry (issue #69).
 */
const PLACEHOLDER_ID_OFFSET = 1000

const KNOWN_MODEL_IDS: Record<number, string> = {
  246: 'gemini-2.5-pro',
  312: 'gemini-2.5-flash',
  313: 'gemini-2.5-flash-thinking',
  329: 'gemini-2.5-flash-thinking',
  330: 'gemini-2.5-flash-lite',
  281: 'claude-4-sonnet',
  282: 'claude-4-sonnet',
  290: 'claude-4-opus',
  291: 'claude-4-opus',
  333: 'claude-sonnet-4-5',
  334: 'claude-sonnet-4-5',
  340: 'claude-haiku-4-5',
  341: 'claude-haiku-4-5',
  342: 'gpt-oss-120b-medium',
  1016: 'gemini-3.1-pro',
  1018: 'gemini-3-flash-preview',
  1020: 'gemini-3.5-flash-medium',
  1026: 'claude-opus-4-6',
  1035: 'claude-sonnet-4-6',
  1036: 'gemini-3.1-pro',
  1037: 'gemini-3.1-pro',
  1047: 'gemini-3-flash-preview',
  1071: 'gemini-3.6-flash',
  1084: 'gemini-3-flash-preview',
  1132: 'gemini-3.5-flash-high',
  1133: 'gemini-3.5-flash-high',
  1187: 'gemini-3.5-flash-extra-low',
  1264: 'gemini-3.6-flash',
  1298: 'gemini-3.7-flash',
  1299: 'gemini-3.7-flash',
  1318: 'gemini-3.8-flash',
}

function cleanModel(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined
  const model = (value.includes('/') ? value.split('/').pop() : value)?.trim()
  return model || undefined
}

function aliasFor(key: string): string | undefined {
  const alias = ANTIGRAVITY_MODEL_ALIASES[key]
  if (alias) return alias
  const placeholder = /^model_placeholder_m(\d+)$/.exec(key)
  return placeholder ? KNOWN_MODEL_IDS[PLACEHOLDER_ID_OFFSET + Number(placeholder[1])] : undefined
}

/** The canonical model a display label, routing alias or placeholder stands for, if known. */
function canonicalModel(value: string | undefined): string | undefined {
  const model = cleanModel(value)
  if (!model) return undefined
  const key = model.toLowerCase()
  const base = key.replace(/\s*\([^)]*\)\s*$/, '').trim()
  return aliasFor(key) ?? aliasFor(base)
}

/** `Gemini 3.5 Flash (Medium)` → `gemini-3.5-flash-medium`; anything else is left alone. */
function geminiLabelSlug(label: string): string | undefined {
  const match = /^gemini (\d+(?:\.\d+)?)((?: [a-z]+)+?)(?: \(([a-z ]+)\))?$/.exec(label.toLowerCase())
  if (!match) return undefined
  const [, version, family, effort = ''] = match
  return ['gemini', version, ...family.trim().split(' '), ...effort.split(' ').filter(Boolean)].join('-')
}

/** Canonical name when known, otherwise the name as Antigravity wrote it. */
function normalizeModel(value: string | undefined): string | undefined {
  const model = cleanModel(value)
  if (!model) return undefined
  return canonicalModel(model) ?? geminiLabelSlug(model) ?? model
}

function knownModelName(modelId: number): string | undefined {
  return KNOWN_MODEL_IDS[modelId] ?? ANTIGRAVITY_MODEL_ALIASES[`model_placeholder_m${modelId - PLACEHOLDER_ID_OFFSET}`]
}

interface ModelCandidates {
  modelId?: number
  /** Model slug Antigravity selected, e.g. `gemini-3.8-flash`, or a routing alias such as `gemini-pro-default`. */
  slug?: string
  /** Executor model, usually effort-qualified, e.g. `gemini-3.8-flash-high`. */
  executor?: string
  /** `MODEL_PLACEHOLDER_M<n>` from the chat model's `model_enum` entry. */
  placeholder?: string
  /** Display label, e.g. `Gemini 3.8 Flash (High)`. */
  label?: string
}

/**
 * Names a generation or step from the metadata Antigravity stores with it.
 * Precedence: a readable name that maps to a known canonical model; a slug or
 * executor model that looks like a real model name (it carries a version
 * number — routing aliases such as `gemini-default` do not); a Gemini display
 * label; the known numeric-id table; any remaining readable name verbatim.
 * A numeric id nobody knows never displaces a readable name; the caller falls
 * back to `antigravity-model-<id>` only when nothing readable exists (issue #68).
 */
function resolveModel(candidates: ModelCandidates): string | undefined {
  const { modelId, slug, executor, placeholder, label } = candidates
  return [slug, executor, placeholder, label].map(canonicalModel).find(Boolean)
    ?? [slug, executor].map(cleanModel).find((name): name is string => name != null && /\d/.test(name))
    ?? geminiLabelSlug(cleanModel(label) ?? '')
    ?? (modelId != null ? knownModelName(modelId) : undefined)
    ?? [slug, executor, label].map(cleanModel).find(Boolean)
}

/** The readable model of `named` when it can describe an event with `modelId`: the ids match, or either side has none. */
function describedBy(named: NamedModel | undefined, modelId: number | undefined): string | undefined {
  if (!named?.model) return undefined
  return modelId == null || named.modelId == null || named.modelId === modelId ? named.model : undefined
}

function modelEnum(chatModel: ProtoField[]): string | undefined {
  for (const entry of messages(chatModel, 20)) {
    if (firstString(entry, [1]) === 'model_enum') return firstString(entry, [2])
  }
  return undefined
}

function parseModelUsage(fields: ProtoField[]): ModelUsage {
  const totalOutputTokens = firstVarint(fields, 3) ?? 0
  const thinkingTokens = firstVarint(fields, 9) ?? 0
  const visibleOutputTokens = firstVarint(fields, 10) ?? 0
  const normalizedTotalOutput = Math.max(totalOutputTokens, visibleOutputTokens + thinkingTokens)
  const responseId = firstString(fields, [11])
  const providerMessageId = firstString(fields, [12])
  const messageId = firstString(fields, [7])
  return {
    modelId: firstVarint(fields, 1) || undefined,
    inputTokens: firstVarint(fields, 2) ?? 0,
    totalOutputTokens: normalizedTotalOutput,
    cacheWriteTokens: firstVarint(fields, 4) ?? 0,
    cacheReadTokens: firstVarint(fields, 5) ?? 0,
    thinkingTokens,
    outputTokens: Math.max(visibleOutputTokens, normalizedTotalOutput - thinkingTokens),
    identities: [
      responseId ? `response:${responseId}` : undefined,
      providerMessageId ? `provider:${providerMessageId}` : undefined,
      messageId ? `message:${messageId}` : undefined,
    ].filter((value): value is string => Boolean(value)),
  }
}

function tokenBearing(usage: ModelUsage): boolean {
  return usage.inputTokens + usage.totalOutputTokens + usage.cacheWriteTokens + usage.cacheReadTokens > 0
}

function usageEvents(fields: ProtoField[], usageField: number, retryField: number, source: string, lineOffset: number, ts?: number): UsageEvent[] {
  const events: UsageEvent[] = []
  const usage = messages(fields, usageField)[0]
  if (usage) events.push({ usage: parseModelUsage(usage), ts, sourceKey: `${source}:usage`, lineOffset })
  for (const [index, retry] of messages(fields, retryField).entries()) {
    const retryUsage = messages(retry, 2)[0]
    if (retryUsage) events.push({ usage: parseModelUsage(retryUsage), ts, sourceKey: `${source}:retry:${index}`, lineOffset })
  }
  return events.filter((event) => tokenBearing(event.usage))
}

function parseGeneration(index: number, data: Buffer, executorModel?: string): GenerationMetadata {
  const metadata = readFields(data)
  const chatModel = firstMessage(metadata, 1)
  const modelId = firstVarint(chatModel, 3) || undefined
  const model = resolveModel({
    modelId,
    slug: firstString(chatModel, [19]),
    executor: firstString(firstMessage(metadata, 3), [28]) ?? executorModel,
    placeholder: modelEnum(chatModel),
    label: firstString(chatModel, [21, 22]),
  })
  const ts = generationTimestamp(chatModel)
  return {
    index,
    modelId,
    model,
    stepIndices: repeatedVarints(metadata, 2),
    events: usageEvents(chatModel, 4, 17, `generation:${index}`, index, ts),
  }
}

function parseStep(index: number, data: Buffer): StepMetadata {
  const metadata = readFields(data)
  const modelInfo = firstMessage(metadata, 24)
  const modelId = firstVarint(modelInfo, 1) || undefined
  const model = normalizeModel(firstString(modelInfo, [12, 8]))
  const ts = timestampFromFields(firstMessage(metadata, 8))
    ?? timestampFromFields(firstMessage(metadata, 1))
  return {
    ts,
    modelId,
    model,
    events: usageEvents(metadata, 9, 28, `step:${index}`, index, ts).map((event) => {
      event.usage.modelId ??= modelId
      return { ...event, model }
    }),
  }
}

/**
 * The model an event is billed to. A readable name that describes the event
 * wins; a numeric id is then resolved through the names this database itself
 * pairs with it, then the known-id table, and only then becomes a placeholder.
 */
function modelForEvent(event: UsageEvent, learned: Map<number, string>): string {
  if (event.model) return event.model
  const modelId = event.usage.modelId
  if (modelId == null) return 'antigravity-unknown'
  return learned.get(modelId) ?? knownModelName(modelId) ?? `antigravity-model-${modelId}`
}

function mergeEvent(target: UsageEvent, duplicate: UsageEvent): void {
  target.usage.modelId ??= duplicate.usage.modelId
  target.usage.inputTokens = Math.max(target.usage.inputTokens, duplicate.usage.inputTokens)
  target.usage.totalOutputTokens = Math.max(target.usage.totalOutputTokens, duplicate.usage.totalOutputTokens)
  target.usage.cacheWriteTokens = Math.max(target.usage.cacheWriteTokens, duplicate.usage.cacheWriteTokens)
  target.usage.cacheReadTokens = Math.max(target.usage.cacheReadTokens, duplicate.usage.cacheReadTokens)
  target.usage.thinkingTokens = Math.max(target.usage.thinkingTokens, duplicate.usage.thinkingTokens)
  target.usage.outputTokens = Math.max(target.usage.outputTokens, duplicate.usage.outputTokens)
  target.usage.identities = [...new Set([...target.usage.identities, ...duplicate.usage.identities])]
  target.model ??= duplicate.model
  target.ts = target.ts == null ? duplicate.ts : duplicate.ts == null ? target.ts : Math.min(target.ts, duplicate.ts)
  if (duplicate.sourceKey < target.sourceKey) target.sourceKey = duplicate.sourceKey
  target.lineOffset = Math.min(target.lineOffset, duplicate.lineOffset)
}

function deduplicateEvents(events: UsageEvent[]): UsageEvent[] {
  const slots: Array<UsageEvent | undefined> = []
  const identitySlots = new Map<string, number>()
  for (const event of events) {
    const matches = [...new Set(event.usage.identities
      .map((identity) => identitySlots.get(identity))
      .filter((value): value is number => value != null))]
    const targetIndex = matches[0] ?? slots.length
    if (matches.length === 0) slots.push(event)
    else mergeEvent(slots[targetIndex]!, event)
    for (const duplicateIndex of matches.slice(1)) {
      if (slots[duplicateIndex]) {
        mergeEvent(slots[targetIndex]!, slots[duplicateIndex]!)
        slots[duplicateIndex] = undefined
      }
    }
    for (const identity of slots[targetIndex]!.usage.identities) identitySlots.set(identity, targetIndex)
  }
  return slots.filter((event): event is UsageEvent => event != null)
}

function hasTable(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table) != null
}

/**
 * Executor model per generation index from the optional `executor_metadata`
 * table (field 28). Current databases embed the same value in the generation
 * row itself; this table is consulted only for generations that lack it.
 */
function readExecutorModels(db: Database.Database): Map<number, string> {
  const models = new Map<number, string>()
  if (!hasTable(db, 'executor_metadata')) return models
  let rows: Array<{ idx: number; data: unknown }>
  try {
    rows = db.prepare('SELECT idx, data FROM executor_metadata ORDER BY idx').all() as Array<{ idx: number; data: unknown }>
  } catch {
    return models
  }
  for (const row of rows) {
    if (!Buffer.isBuffer(row.data)) continue
    try {
      const model = firstString(readFields(row.data), [28])
      if (model) models.set(Number(row.idx), model)
    } catch {
      // Auxiliary hint only: an unreadable executor row never fails the import.
    }
  }
  return models
}

function readTrajectoryTimestamp(db: Database.Database, errors: string[]): number | undefined {
  try {
    if (!hasTable(db, 'trajectory_metadata_blob')) return undefined
    const rows = db.prepare('SELECT data FROM trajectory_metadata_blob ORDER BY rowid').all() as Array<{ data: unknown }>
    let timestamp: number | undefined
    for (const [index, row] of rows.entries()) {
      try {
        if (!Buffer.isBuffer(row.data)) throw new Error('trajectory metadata is not a blob')
        const candidate = timestampFromFields(firstMessage(readFields(row.data), 2))
        timestamp ??= candidate
      } catch (error) {
        errors.push(`trajectory metadata ${index}: ${error instanceof Error ? error.message : error}`)
      }
    }
    return timestamp
  } catch (error) {
    errors.push(`trajectory metadata: ${error instanceof Error ? error.message : error}`)
    return undefined
  }
}

export function runParseAntigravity(db: Database.Database, options: AntigravityImportOptions): AntigravityImportResult {
  const { dbPath, device, deviceInstanceId, platform, now, fallbackTs, startIndex, exchangeRate } = options
  const errors: string[] = []
  const firstIndex = Math.max(0, startIndex)
  let nextIndex = firstIndex

  if (!hasTable(db, 'gen_metadata')) {
    return { records: [], nextIndex, errors: ['conversation database does not contain gen_metadata table'] }
  }

  const trajectoryTs = readTrajectoryTimestamp(db, errors)
  const executorModels = readExecutorModels(db)
  const generations: GenerationMetadata[] = []
  const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all() as Array<{ idx: number; data: Buffer }>
  const latestGenerationIndex = Math.max(-1, ...rows.map((row) => Number(row.idx)).filter(Number.isFinite))
  for (const row of rows) {
    const index = Number(row.idx)
    try {
      if (!Buffer.isBuffer(row.data)) throw new Error('generation metadata is not a blob')
      generations.push(parseGeneration(index, row.data, executorModels.get(index)))
    } catch (error) {
      if (index >= firstIndex) {
        errors.push(`generation metadata ${index}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }

  const selected = generations.filter((generation) => generation.index >= firstIndex)
  let previousStep = Math.max(-1, ...generations
    .filter((generation) => generation.index < firstIndex)
    .flatMap((generation) => generation.stepIndices))
  const steps = new Map<number, StepMetadata>()
  if (hasTable(db, 'steps')) {
    const stepRows = db.prepare('SELECT idx, metadata FROM steps WHERE metadata IS NOT NULL ORDER BY idx').all() as Array<{ idx: number; metadata: Buffer }>
    for (const row of stepRows) {
      const index = Number(row.idx)
      if (index <= previousStep || !Buffer.isBuffer(row.metadata)) continue
      try {
        steps.set(index, parseStep(index, row.metadata))
      } catch (error) {
        errors.push(`step metadata ${index}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }

  // Numeric ids this database pairs with readable names: an event whose id is
  // known only here (a helper model, a retry on another model) is named from
  // the rows that spell it out rather than from the hard-coded table.
  const learned = new Map<number, string>()
  const learn = (named: NamedModel): void => {
    if (named.modelId != null && named.model && !learned.has(named.modelId)) learned.set(named.modelId, named.model)
  }
  for (const generation of generations) learn(generation)
  for (const step of steps.values()) learn(step)

  const events: UsageEvent[] = []
  let current: NamedModel | undefined = generations
    .filter((generation) => generation.index < firstIndex && generation.model)
    .pop()
  const lastNamed: NamedModel | undefined = [...generations].reverse().find((generation) => generation.model)

  for (const generation of selected) {
    if (generation.model) current = generation
    const lastStep = generation.stepIndices.length > 0 ? Math.max(...generation.stepIndices) : previousStep
    const linkedTs = generation.stepIndices.map((index) => steps.get(index)?.ts).find((ts) => ts != null)
    const rowEvents = [
      ...[...steps.entries()]
        .filter(([index]) => index > previousStep && index <= lastStep)
        .flatMap(([, step]) => step.events),
      ...generation.events.map((event) => ({ ...event, ts: event.ts ?? linkedTs })),
    ]
    if (rowEvents.length === 0 && generation.index === latestGenerationIndex) break
    nextIndex = generation.index + 1
    previousStep = lastStep
    if (rowEvents.length === 0) continue
    for (const event of rowEvents) {
      event.model ??= describedBy(current, event.usage.modelId) ?? describedBy(lastNamed, event.usage.modelId)
    }
    events.push(...rowEvents)
  }

  const sessionId = basename(dbPath).replace(/\.db$/i, '') || 'unknown'
  const records = deduplicateEvents(events).map((event, index): StatsRecord => {
    const model = modelForEvent(event, learned)
    const provider = inferProvider(model)
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, thinkingTokens } = event.usage
    const tokenArgs = { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, thinkingTokens }
    const hasPrice = resolvePrice(model) != null
    const identity = [...event.usage.identities].sort()[0] ?? event.sourceKey
    return {
      id: generateRecordId(deviceInstanceId, `antigravity:${sessionId}:${identity}`, 0),
      ts: event.ts ?? trajectoryTs ?? fallbackTs + index,
      ingestedAt: now,
      updatedAt: now,
      lineOffset: event.lineOffset,
      tool: 'antigravity',
      model,
      provider,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      thinkingTokens,
      cost: hasPrice ? calculateCost(model, tokenArgs, exchangeRate) : 0,
      costSource: hasPrice ? 'pricing' : 'unknown',
      sessionId,
      sourceFile: dbPath,
      device,
      deviceInstanceId,
      platform,
    }
  })

  return { records, nextIndex, errors }
}
