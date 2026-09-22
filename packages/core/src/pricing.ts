import { FALLBACK_RATE, convertToUSD } from './exchange-rate.js'

export interface PriceEntry {
  input: number        // per 1M tokens (in currency unit)
  output: number       // per 1M tokens (in currency unit)
  cacheRead?: number   // per 1M tokens (in currency unit)
  cacheWrite?: number  // per 1M tokens (in currency unit)
  currency?: 'CNY' | 'USD'  // defaults to 'USD' if omitted
}

// Runtime-mutable price table. Hosts such as the CLI and site load this from
// their pricing registry database instead of relying on package-bundled data.
let basePriceTable: Record<string, PriceEntry> = {}
let userOverrides: Record<string, PriceEntry> = {}
const resolvedPriceCache = new Map<string, PriceEntry | undefined>()

export const DEFAULT_PRICE_TABLE: Record<string, PriceEntry> = {}

export let PRICE_TABLE: Record<string, PriceEntry> = {}

export function getPriceTable(): Record<string, PriceEntry> {
  return { ...basePriceTable, ...userOverrides }
}

export function setBasePriceTable(table: Record<string, PriceEntry>): void {
  basePriceTable = { ...table }
  PRICE_TABLE = { ...basePriceTable, ...userOverrides }
  resolvedPriceCache.clear()
}

export function setRuntimePriceTable(base: Record<string, PriceEntry>, overrides: Record<string, PriceEntry> = {}): void {
  basePriceTable = { ...base }
  userOverrides = { ...overrides }
  PRICE_TABLE = { ...basePriceTable, ...userOverrides }
  resolvedPriceCache.clear()
}

export function getBasePriceTable(): Record<string, PriceEntry> {
  return { ...basePriceTable }
}

export function setPriceOverride(model: string, entry: PriceEntry): void {
  userOverrides = { ...userOverrides, [model]: entry }
  PRICE_TABLE = { ...basePriceTable, ...userOverrides }
  resolvedPriceCache.clear()
}

export function removePriceOverride(model: string): void {
  const { [model]: _, ...rest } = userOverrides
  userOverrides = rest
  PRICE_TABLE = { ...basePriceTable, ...userOverrides }
  resolvedPriceCache.clear()
}

export function getUserOverrides(): Record<string, PriceEntry> {
  return { ...userOverrides }
}

export interface CuratedPrice {
  modelKey: string
  provider: string
  price: PriceEntry
  sourceUrl: string
}

const ANTHROPIC_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing'
const OPENAI_PRICING_URL = 'https://developers.openai.com/api/docs/pricing'

/**
 * Prices for models that hosts should know without waiting for a LiteLLM sync.
 * A registry synced before a model launched has no row for it, and prefix
 * matching then prices it as an older sibling: `claude-opus-5-5` resolved to
 * `claude-opus-5` and showed $5/$25 instead of $4/$20. Hosts seed these as
 * builtin prices when no row exists for the key; a later LiteLLM sync or a user
 * price takes over from there. Rates are USD per 1M tokens at the standard
 * (short-context, global) tier; `cacheWrite` is the 5-minute write rate.
 */
export const CURATED_PRICES: ReadonlyArray<CuratedPrice> = [
  {
    modelKey: 'claude-opus-5-5',
    provider: 'anthropic',
    price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, currency: 'USD' },
    sourceUrl: ANTHROPIC_PRICING_URL,
  },
  {
    modelKey: 'gpt-6-sol',
    provider: 'openai',
    price: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, currency: 'USD' },
    sourceUrl: OPENAI_PRICING_URL,
  },
  {
    modelKey: 'gpt-6-luna',
    provider: 'openai',
    price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, currency: 'USD' },
    sourceUrl: OPENAI_PRICING_URL,
  },
]

const PROVIDER_PREFIXES = [
  'accounts/fireworks/models/',
  'moonshotai/',
  'z-ai/',
  'zai-org/',
  'frank/',
  'nvidia/',
  'glink/',
  'antchat/',
]

/**
 * Resolve price for a model: exact match first, then prefix match.
 * Strips known provider prefixes before matching.
 * e.g. 'claude-haiku-4-5-20251001' matches 'claude-haiku-4-5'
 *      'z-ai/glm-5-20260211' matches 'glm-5'
 */
export function resolvePrice(model: string): PriceEntry | undefined {
  if (resolvedPriceCache.has(model)) return resolvedPriceCache.get(model)
  const price = resolvePriceFromTable(model, PRICE_TABLE)
  resolvedPriceCache.set(model, price)
  return price
}

export { resolvePriceFromTable }

function resolvePriceFromTable(model: string, table: Record<string, PriceEntry>): PriceEntry | undefined {
  // Exact match
  if (table[model]) return table[model]

  // Strip provider prefix and try again
  let stripped = model
  for (const prefix of PROVIDER_PREFIXES) {
    if (stripped.startsWith(prefix)) {
      stripped = stripped.slice(prefix.length)
      break
    }
  }
  if (stripped !== model) {
    const lc = stripped.toLowerCase()
    if (table[lc]) return table[lc]
    if (table[stripped]) return table[stripped]
  }

  // Prefix match (longest prefix wins) — try original, stripped, and lowercase variants
  let bestPrefix = ''
  let bestEntry: PriceEntry | undefined
  const candidates = [model, stripped, stripped.toLowerCase()]
  for (const c of candidates) {
    for (const [prefix, entry] of Object.entries(table)) {
      if (c.startsWith(prefix) && prefix.length > bestPrefix.length) {
        bestPrefix = prefix
        bestEntry = entry
      }
    }
  }
  return bestEntry
}

function calculateCostWithResolver(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    thinkingTokens: number
  },
  exchangeRate: number | undefined,
  resolver: (model: string) => PriceEntry | undefined
): number {
  const price = resolver(model)
  if (!price) return 0

  const inputCost = (tokens.inputTokens / 1_000_000) * price.input
  const outputCost = (tokens.outputTokens / 1_000_000) * price.output
  const cacheReadCost = (tokens.cacheReadTokens / 1_000_000) * (price.cacheRead ?? 0)
  const cacheWriteCost = (tokens.cacheWriteTokens / 1_000_000) * (price.cacheWrite ?? 0)
  const thinkingCost = (tokens.thinkingTokens / 1_000_000) * price.output

  const rawCost = inputCost + outputCost + cacheReadCost + cacheWriteCost + thinkingCost

  if (price.currency === 'CNY') {
    return convertToUSD(rawCost, exchangeRate ?? FALLBACK_RATE)
  }
  return rawCost
}

export function calculateCost(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    thinkingTokens: number
  },
  exchangeRate?: number
): number {
  return calculateCostWithResolver(model, tokens, exchangeRate, resolvePrice)
}

export function calculateCostForPrice(
  price: PriceEntry,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    thinkingTokens: number
  },
  exchangeRate?: number
): number {
  const inputCost = (tokens.inputTokens / 1_000_000) * price.input
  const outputCost = (tokens.outputTokens / 1_000_000) * price.output
  const cacheReadCost = (tokens.cacheReadTokens / 1_000_000) * (price.cacheRead ?? 0)
  const cacheWriteCost = (tokens.cacheWriteTokens / 1_000_000) * (price.cacheWrite ?? 0)
  const thinkingCost = (tokens.thinkingTokens / 1_000_000) * price.output
  const rawCost = inputCost + outputCost + cacheReadCost + cacheWriteCost + thinkingCost
  return price.currency === 'CNY' ? convertToUSD(rawCost, exchangeRate ?? FALLBACK_RATE) : rawCost
}
