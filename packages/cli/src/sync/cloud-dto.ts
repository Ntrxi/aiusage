import type { SyncRecord } from '@aiusage/core'

/**
 * Wire shape of a record on the cloud sync API, and the only place that
 * knows how it differs from `SyncRecord`.
 *
 * The server stores the device alias as `device_name` and calls it
 * `deviceName` in JSON on both sides of the API (`/sync/push` reads it,
 * `/sync/pull` writes it), whereas the core `SyncRecord` — the shape the
 * file backends put on the wire and the local tables use — calls it
 * `device`. Every other field keeps its `SyncRecord` name. Integer columns
 * are Postgres bigints, which the server's driver serialises as strings.
 *
 * Records go out through `toCloudRecord` and come in through
 * `fromCloudRecord`. Ownership is not touched: `deviceInstanceId` names the
 * origin device on both sides, and `id` is the wire id the origin device
 * publishes under.
 */
export interface CloudWireRecord extends Omit<SyncRecord, 'device'> {
  deviceName: string
}

export function toCloudRecord(record: SyncRecord): CloudWireRecord {
  const { device, ...rest } = record
  return { ...rest, deviceName: device }
}

const COST_SOURCES = new Set<SyncRecord['costSource']>(['log', 'pricing', 'unknown'])

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** A number, or a numeric string (Postgres bigint / numeric); `undefined` otherwise. */
function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/**
 * Parse one record as `/sync/pull` returns it. Returns `null` when the
 * record lacks any required `SyncRecord` field. Callers reconcile against the
 * pull, so a record they cannot represent must fail the pull rather than vanish from
 * it. Nullable optional metadata is omitted.
 * `device` is accepted as a fallback for `deviceName` so a server that
 * predates the field still round-trips.
 */
export function fromCloudRecord(raw: unknown): SyncRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const id = str(r.id)
  const deviceInstanceId = str(r.deviceInstanceId)
  const tool = str(r.tool)
  const model = str(r.model)
  const ts = num(r.ts)
  const updatedAt = num(r.updatedAt)
  if (!id || !deviceInstanceId || !tool || !model || ts === undefined || updatedAt === undefined) return null
  const costSource = str(r.costSource)
  const provider = str(r.provider)
  const sessionKey = str(r.sessionKey)
  const device = str(r.deviceName ?? r.device)
  const inputTokens = num(r.inputTokens)
  const outputTokens = num(r.outputTokens)
  const cacheReadTokens = num(r.cacheReadTokens)
  const cacheWriteTokens = num(r.cacheWriteTokens)
  const thinkingTokens = num(r.thinkingTokens)
  const cost = num(r.cost)
  if (provider === undefined || sessionKey === undefined || device === undefined
    || inputTokens === undefined || outputTokens === undefined || cacheReadTokens === undefined
    || cacheWriteTokens === undefined || thinkingTokens === undefined || cost === undefined
    || !COST_SOURCES.has(costSource as SyncRecord['costSource'])) return null
  const platform = str(r.platform)
  const sourceFile = str(r.sourceFile)
  const cwd = str(r.cwd)
  return {
    id,
    ts,
    tool: tool as SyncRecord['tool'],
    model,
    provider,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    thinkingTokens,
    cost,
    costSource: costSource as SyncRecord['costSource'],
    sessionKey,
    device,
    deviceInstanceId,
    ...(platform ? { platform } : {}),
    updatedAt,
    ...(sourceFile ? { sourceFile } : {}),
    ...(cwd ? { cwd } : {}),
  }
}
