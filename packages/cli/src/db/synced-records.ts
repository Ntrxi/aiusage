import type Database from 'better-sqlite3'
import type { SyncRecord } from '@aiusage/core'

export function insertSyncedRecord(db: Database.Database, record: SyncRecord): boolean {
  // Only replace if the incoming record is newer than what we already have.
  // Without this check, a stale remote record could silently overwrite a newer one.
  const result = db.prepare(`
    INSERT INTO synced_records (
      id, ts, tool, model, provider, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, thinking_tokens,
      cost, cost_source, session_key, device, device_instance_id, platform, updated_at,
      source_file, cwd
    ) VALUES (
      @id, @ts, @tool, @model, @provider, @inputTokens, @outputTokens,
      @cacheReadTokens, @cacheWriteTokens, @thinkingTokens,
      @cost, @costSource, @sessionKey, @device, @deviceInstanceId, @platform, @updatedAt,
      @sourceFile, @cwd
    )
    ON CONFLICT(id) DO UPDATE SET
      ts = excluded.ts,
      tool = excluded.tool,
      model = excluded.model,
      provider = excluded.provider,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_tokens = excluded.cache_write_tokens,
      thinking_tokens = excluded.thinking_tokens,
      cost = excluded.cost,
      cost_source = excluded.cost_source,
      session_key = excluded.session_key,
      device = excluded.device,
      device_instance_id = excluded.device_instance_id,
      platform = excluded.platform,
      updated_at = excluded.updated_at,
      source_file = excluded.source_file,
      cwd = excluded.cwd
    WHERE excluded.updated_at > synced_records.updated_at
  `).run({
    id: record.id,
    ts: record.ts,
    tool: record.tool,
    model: record.model,
    provider: record.provider,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheWriteTokens: record.cacheWriteTokens,
    thinkingTokens: record.thinkingTokens,
    cost: record.cost,
    costSource: record.costSource,
    sessionKey: record.sessionKey,
    device: record.device,
    deviceInstanceId: record.deviceInstanceId,
    platform: record.platform ?? '',
    updatedAt: record.updatedAt,
    sourceFile: record.sourceFile ?? '',
    cwd: record.cwd ?? '',
  })
  return result.changes > 0
}

export function getSyncedRecordById(db: Database.Database, id: string): SyncRecord | null {
  const row = db.prepare('SELECT * FROM synced_records WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) return null
  return mapRowToSyncRecord(row)
}

/**
 * Merge synced_records into records table so API queries can see them.
 * Only inserts records that don't already exist in records.
 *
 * Every row written here is stamped `origin = 'synced'` — that flag, not the
 * `source_file` value, is what marks it as pulled. `source_file` and `cwd`
 * are copied verbatim so cross-device project stats keep working.
 *
 * Rows carrying `currentDeviceInstanceId` (when given) are skipped: a copy of
 * this device's own record can only reach `synced_records` by being echoed
 * through another device's namespace, and the authoritative row already lives
 * in `records` with `origin = 'local'`.
 *
 * Returns the number of newly inserted records.
 */
export function mergeSyncedRecordsIntoRecords(db: Database.Database, currentDeviceInstanceId?: string): number {
  const now = Date.now()
  const ownFilter = currentDeviceInstanceId !== undefined ? 'AND sr.device_instance_id != @currentDeviceInstanceId' : ''
  const newRows = db.prepare(`
    SELECT sr.* FROM synced_records sr
    LEFT JOIN records r ON sr.id = r.id
    WHERE r.id IS NULL ${ownFilter}
  `).all(currentDeviceInstanceId !== undefined ? { currentDeviceInstanceId } : {}) as Record<string, unknown>[]

  if (newRows.length === 0) return 0

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO records (
      id, ts, ingested_at, synced_at, updated_at, line_offset,
      tool, model, provider, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, thinking_tokens,
      cost, cost_source, session_id, source_file, cwd, device, device_instance_id, platform, origin
    ) VALUES (
      @id, @ts, @ingestedAt, @syncedAt, @updatedAt, 0,
      @tool, @model, @provider, @inputTokens, @outputTokens,
      @cacheReadTokens, @cacheWriteTokens, @thinkingTokens,
      @cost, @costSource, @sessionId, @sourceFile, @cwd, @device, @deviceInstanceId, @platform, 'synced'
    )
  `)

  const tx = db.transaction((rows: Record<string, unknown>[]) => {
    for (const row of rows) {
      const sourceFile = (typeof row.source_file === 'string' && row.source_file)
        ? row.source_file
        : `synced/${row.device_instance_id}`
      insertStmt.run({
        id: row.id,
        ts: row.ts,
        ingestedAt: now,
        syncedAt: now,
        updatedAt: row.updated_at,
        tool: row.tool,
        model: row.model,
        provider: row.provider,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        thinkingTokens: row.thinking_tokens,
        cost: row.cost,
        costSource: row.cost_source,
        sessionId: row.session_key,
        sourceFile,
        cwd: (typeof row.cwd === 'string' ? row.cwd : '') || '',
        device: row.device,
        deviceInstanceId: row.device_instance_id,
        platform: (typeof row.platform === 'string' ? row.platform : '') || '',
      })
    }
  })

  tx(newRows)
  return newRows.length
}

function mapRowToSyncRecord(row: Record<string, unknown>): SyncRecord {
  return {
    id: row.id as string,
    ts: row.ts as number,
    tool: row.tool as SyncRecord['tool'],
    model: row.model as string,
    provider: row.provider as string,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    cacheReadTokens: row.cache_read_tokens as number,
    cacheWriteTokens: row.cache_write_tokens as number,
    thinkingTokens: row.thinking_tokens as number,
    cost: row.cost as number,
    costSource: row.cost_source as SyncRecord['costSource'],
    sessionKey: row.session_key as string,
    device: row.device as string,
    deviceInstanceId: row.device_instance_id as string,
    platform: row.platform as string | undefined,
    updatedAt: row.updated_at as number,
    sourceFile: (row.source_file as string) || undefined,
    cwd: (row.cwd as string) || undefined,
  }
}
