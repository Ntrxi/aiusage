import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { CURATED_PRICE_ALIASES, getBasePriceTable, getUserOverrides, resolvePrice, setRuntimePriceTable } from '@aiusage/core'
import { initializeDatabase } from '../src/db/index.js'
import { ensureCuratedPricingAliases, loadPricingRuntime, resolvePriceFromRegistry, setUserPricingAlias } from '../src/pricing-registry.js'

describe('curated pricing aliases (issue #69)', () => {
  let db: Database.Database
  const runtimeBase = getBasePriceTable()
  const runtimeOverrides = getUserOverrides()

  function insertPrice(modelKey: string, input: number, output: number, status = 'active'): void {
    const now = Date.now()
    db.prepare(`
      INSERT INTO model_prices (
        model_key, provider, input, output, cache_read, cache_write, currency, source, source_model_id,
        source_url, origin, status, last_synced_at, created_at, updated_at
      ) VALUES (?, 'gemini', ?, ?, NULL, NULL, 'USD', 'litellm', ?, NULL, 'builtin', ?, ?, ?, ?)
    `).run(modelKey, input, output, modelKey, status, now, now, now)
  }

  function aliasRow(alias: string): { model_key: string; origin: string; source: string } | undefined {
    return db.prepare('SELECT model_key, origin, source FROM model_price_aliases WHERE alias = ?').get(alias) as
      { model_key: string; origin: string; source: string } | undefined
  }

  beforeEach(() => {
    db = new Database(':memory:')
    initializeDatabase(db)
  })

  afterEach(() => {
    db.close()
    setRuntimePriceTable(runtimeBase, runtimeOverrides)
  })

  it('points every curated alias at a longer registry key of the same family', () => {
    for (const { alias, modelKey } of CURATED_PRICE_ALIASES) {
      expect(modelKey.length).toBeGreaterThan(alias.replace(/-(high|low)$/, '').length)
      expect(modelKey.startsWith(alias.replace(/-(high|low)$/, ''))).toBe(true)
    }
  })

  it('seeds an alias only once its target price exists, and only once', () => {
    expect(ensureCuratedPricingAliases(db)).toBe(0)
    expect(aliasRow('gemini-3.1-pro')).toBeUndefined()

    insertPrice('gemini-3.1-pro-preview', 2, 12)

    expect(ensureCuratedPricingAliases(db)).toBe(3)
    expect(aliasRow('gemini-3.1-pro')).toMatchObject({ model_key: 'gemini-3.1-pro-preview', origin: 'builtin', source: 'aiusage' })
    expect(aliasRow('gemini-3.1-pro-high')).toMatchObject({ model_key: 'gemini-3.1-pro-preview' })
    expect(aliasRow('gemini-3.1-pro-low')).toMatchObject({ model_key: 'gemini-3.1-pro-preview' })
    expect(aliasRow('gemini-3-pro')).toBeUndefined()
    expect(ensureCuratedPricingAliases(db)).toBe(0)
  })

  it('ignores inactive target prices', () => {
    insertPrice('gemini-3.1-pro-preview', 2, 12, 'retired')

    expect(ensureCuratedPricingAliases(db)).toBe(0)
    expect(aliasRow('gemini-3.1-pro')).toBeUndefined()
  })

  it('does not shadow a real price registered under the alias name', () => {
    insertPrice('gemini-3.1-pro-preview', 2, 12)
    insertPrice('gemini-3.1-pro', 1, 5)

    expect(ensureCuratedPricingAliases(db)).toBe(2)
    expect(aliasRow('gemini-3.1-pro')).toBeUndefined()
    expect(aliasRow('gemini-3.1-pro-high')).toMatchObject({ model_key: 'gemini-3.1-pro-preview' })
    expect(resolvePriceFromRegistry(db, 'gemini-3.1-pro')).toMatchObject({ input: 1, output: 5 })
  })

  it('removes an alias it seeded once a real price appears under that name', () => {
    insertPrice('gemini-3.1-pro-preview', 2, 12)
    expect(ensureCuratedPricingAliases(db)).toBe(3)
    expect(resolvePriceFromRegistry(db, 'gemini-3.1-pro')).toMatchObject({ input: 2, output: 12 })

    insertPrice('gemini-3.1-pro', 1, 5)
    expect(ensureCuratedPricingAliases(db)).toBe(0)

    expect(aliasRow('gemini-3.1-pro')).toBeUndefined()
    expect(aliasRow('gemini-3.1-pro-high')).toMatchObject({ model_key: 'gemini-3.1-pro-preview' })
    expect(resolvePriceFromRegistry(db, 'gemini-3.1-pro')).toMatchObject({ input: 1, output: 5 })
    loadPricingRuntime(db)
    expect(resolvePrice('gemini-3.1-pro')).toMatchObject({ input: 1, output: 5 })
  })

  it('does not resurrect a disabled alias', () => {
    insertPrice('gemini-3.1-pro-preview', 2, 12)
    const now = Date.now()
    db.prepare(`
      INSERT INTO model_price_aliases (alias, model_key, match_type, provider, priority, source, origin, enabled, created_at, updated_at)
      VALUES ('gemini-3.1-pro', 'gemini-3.1-pro-preview', 'exact', 'gemini', 100, 'aiusage', 'builtin', 0, ?, ?)
    `).run(now, now)

    expect(ensureCuratedPricingAliases(db)).toBe(2)
    expect(db.prepare('SELECT enabled FROM model_price_aliases WHERE alias = ?').get('gemini-3.1-pro')).toEqual({ enabled: 0 })
  })

  it('never overrides an alias that already exists', () => {
    insertPrice('gemini-3.1-pro-preview', 2, 12)
    insertPrice('gemini-3-pro-preview', 1, 6)
    setUserPricingAlias(db, 'gemini-3.1-pro', 'gemini-3-pro-preview')

    ensureCuratedPricingAliases(db)

    expect(aliasRow('gemini-3.1-pro')).toMatchObject({ model_key: 'gemini-3-pro-preview', origin: 'user' })
    expect(aliasRow('gemini-3.1-pro-high')).toMatchObject({ model_key: 'gemini-3.1-pro-preview', origin: 'builtin' })
  })

  it('resolves the Gemini 3.1 Pro family from the registry and from the runtime price table', () => {
    insertPrice('gemini-3.1-pro-preview', 2, 12)
    ensureCuratedPricingAliases(db)

    for (const model of ['gemini-3.1-pro', 'gemini-3.1-pro-high', 'gemini-3.1-pro-low']) {
      expect(resolvePriceFromRegistry(db, model)).toMatchObject({ input: 2, output: 12 })
    }

    loadPricingRuntime(db)
    expect(resolvePrice('gemini-3.1-pro')).toMatchObject({ input: 2, output: 12 })
    expect(resolvePrice('gemini-3.1-pro-high')).toMatchObject({ input: 2, output: 12 })
    expect(resolvePrice('gemini-3.1-pro-low')).toMatchObject({ input: 2, output: 12 })
  })

  it('is applied whenever a database is opened after prices were synced', () => {
    insertPrice('gemini-3-pro-preview', 2, 12)
    expect(aliasRow('gemini-3-pro')).toBeUndefined()

    initializeDatabase(db)

    expect(aliasRow('gemini-3-pro')).toMatchObject({ model_key: 'gemini-3-pro-preview', origin: 'builtin' })
    expect(resolvePrice('gemini-3-pro-high')).toMatchObject({ input: 2, output: 12 })
  })
})
