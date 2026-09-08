import { setRuntimePriceTable, type PriceEntry } from '@aiusage/core'

const TEST_PRICE_TABLE: Record<string, PriceEntry> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'gemini-3-pro': { input: 2, output: 12, cacheRead: 0.2 },
  'gemini-3.5-flash-high': { input: 0.5, output: 3, cacheRead: 0.05 },
  'gpt-4o': { input: 2.5, output: 10 },
  'qoder-auto': { input: 2, output: 2, cacheRead: 2, cacheWrite: 2 },
  'qoder-ultimate': { input: 1.6, output: 1.6, cacheRead: 1.6, cacheWrite: 1.6 },
  'qoder-efficient': { input: 0.6, output: 0.6, cacheRead: 0.6, cacheWrite: 0.6 },
}

setRuntimePriceTable(TEST_PRICE_TABLE)
