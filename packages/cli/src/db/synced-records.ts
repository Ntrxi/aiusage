import type Database from 'better-sqlite3'
import type { SyncRecord } from '@aiusage/core'
import { UNKNOWN_DEVICE_INSTANCE_ID } from './records.js'
import { releaseClaim } from './sync-claims.js'

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
 * Release `target`'s claim on a pulled record and, when no target claims it
 * any more, remove it from both `synced_records` and its merged copy in
 * `records`. Locally parsed rows (`origin = 'local'`) are never touched.
 * Returns true when a `synced_records` row was removed.
 */
export function deleteSyncedRecord(db: Database.Database, target: string, id: string): boolean {
  return db.transaction(() => {
    if (!releaseClaim(db, target, id)) return false
    const removed = db.prepare(`DELETE FROM synced_records WHERE id = ?`).run(id).changes > 0
    db.prepare(`DELETE FROM records WHERE id = ? AND origin = 'synced'`).run(id)
    return removed
  })()
}

function fillRemoteIds(db: Database.Database, ids: Iterable<string>): void {
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS sync_remote_ids (id TEXT PRIMARY KEY)`)
  db.exec(`DELETE FROM sync_remote_ids`)
  const insert = db.prepare(`INSERT OR IGNORE INTO sync_remote_ids (id) VALUES (?)`)
  for (const id of ids) insert.run(id)
}

/**
 * Make the local mirror of `owner`'s namespace, as seen from `target`, match
 * `remoteIds` exactly.
 *
 *  - Legacy rows stamped `'unknown'` (or empty) whose id is present in the
 *    namespace are relabelled to `owner`: the namespace they sit in is the
 *    device that parsed them, and exposing `'unknown'` as a device of its own
 *    was a display bug.
 *  - `target`'s claims for `owner` are replaced by `remoteIds`.
 *  - Rows attributed to `owner` that no target claims any more are removed
 *    from `synced_records`, together with their merged copies in `records`
 *    (`origin = 'synced'` only). A row another target still claims survives,
 *    and locally parsed rows are never deleted here.
 *
 * Callers must only invoke this with a `remoteIds` set they read completely
 * and reliably; a namespace whose files could not all be read or parsed must
 * be skipped, never reconciled against a partial set.
 *
 * Returns the number of `synced_records` rows removed.
 */
export function reconcileSyncedNamespace(db: Database.Database, target: string, owner: string, remoteIds: Iterable<string>): number {
  return db.transaction(() => {
    fillRemoteIds(db, remoteIds)

    if (owner !== '' && owner !== UNKNOWN_DEVICE_INSTANCE_ID) {
      db.prepare(`
        UPDATE synced_records SET device_instance_id = @owner
        WHERE device_instance_id IN ('${UNKNOWN_DEVICE_INSTANCE_ID}', '')
          AND id IN (SELECT id FROM sync_remote_ids)
      `).run({ owner })
      db.prepare(`
        UPDATE records SET device_instance_id = @owner
        WHERE origin = 'synced'
          AND device_instance_id IN ('${UNKNOWN_DEVICE_INSTANCE_ID}', '')
          AND id IN (SELECT id FROM sync_remote_ids)
      `).run({ owner })
    }

    db.prepare(`DELETE FROM sync_record_claims WHERE target = @target AND device_instance_id = @owner`).run({ target, owner })
    db.prepare(`
      INSERT OR IGNORE INTO sync_record_claims (target, device_instance_id, record_id)
      SELECT @target, @owner, id FROM sync_remote_ids
    `).run({ target, owner })

    const pruned = db.prepare(`
      DELETE FROM synced_records
      WHERE device_instance_id = @owner
        AND id NOT IN (SELECT record_id FROM sync_record_claims)
    `).run({ owner }).changes
    db.prepare(`
      DELETE FROM records
      WHERE origin = 'synced'
        AND device_instance_id = @owner
        AND id NOT IN (SELECT record_id FROM sync_record_claims)
    `).run({ owner })

    db.exec(`DELETE FROM sync_remote_ids`)
    return pruned
  })()
}

/**
 * Drop legacy pulled rows still stamped `'unknown'` that no target claims.
 * Such rows can only be left over from an old client whose device has since
 * re-published its namespace under its real id (the records arrive again
 * under that id and the old copies would otherwise show up as a phantom third
 * device). Returns the number of `synced_records` rows removed.
 */
export function pruneUnclaimedUnknownSyncedRecords(db: Database.Database): number {
  return db.transaction(() => {
    const pruned = db.prepare(`
      DELETE FROM synced_records
      WHERE device_instance_id IN ('${UNKNOWN_DEVICE_INSTANCE_ID}', '')
        AND id NOT IN (SELECT record_id FROM sync_record_claims)
    `).run().changes
    db.prepare(`
      DELETE FROM records
      WHERE origin = 'synced'
        AND device_instance_id IN ('${UNKNOWN_DEVICE_INSTANCE_ID}', '')
        AND id NOT IN (SELECT record_id FROM sync_record_claims)
    `).run()
    return pruned
  })()
}

/**
 * Pulled rows that no target claims, grouped by the device they are
 * attributed to. These predate migration v14 (claims did not exist yet) or
 * arrived through a namespace that has not been reconciled since; only the
 * caller can tell whether their device still publishes anywhere.
 */
export function getUnclaimedSyncedRecords(db: Database.Database): Map<string, string[]> {
  const rows = db.prepare(`
    SELECT id, device_instance_id FROM synced_records
    WHERE id NOT IN (SELECT record_id FROM sync_record_claims)
    ORDER BY device_instance_id, id
  `).all() as Array<{ id: string; device_instance_id: string }>
  const byOwner = new Map<string, string[]>()
  for (const row of rows) {
    const list = byOwner.get(row.device_instance_id) ?? []
    list.push(row.id)
    byOwner.set(row.device_instance_id, list)
  }
  return byOwner
}

/**
 * Remove unclaimed pulled rows attributed to any device in `owners`, with
 * their merged copies. Used when the caller has established that those
 * devices publish nowhere this client can still reach. Returns the number of
 * `synced_records` rows removed.
 */
export function pruneUnclaimedSyncedRecordsOf(db: Database.Database, owners: Iterable<string>): number {
  return db.transaction(() => {
    fillRemoteIds(db, owners)
    const pruned = db.prepare(`
      DELETE FROM synced_records
      WHERE device_instance_id IN (SELECT id FROM sync_remote_ids)
        AND id NOT IN (SELECT record_id FROM sync_record_claims)
    `).run().changes
    db.prepare(`
      DELETE FROM records
      WHERE origin = 'synced'
        AND device_instance_id IN (SELECT id FROM sync_remote_ids)
        AND id NOT IN (SELECT record_id FROM sync_record_claims)
    `).run()
    db.exec(`DELETE FROM sync_remote_ids`)
    return pruned
  })()
}

/**
 * Merge synced_records into records table so API queries can see them.
 * Inserts records that don't already exist in records and refreshes merged
 * copies (`origin = 'synced'`) whose remote counterpart has been updated
 * since, so both tables always describe the same remote state.
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
  const params = currentDeviceInstanceId !== undefined ? { currentDeviceInstanceId } : {}

  // Refresh merged copies that fell behind their synced_records row.
  db.prepare(`
    UPDATE records SET
      ts = sr.ts, updated_at = sr.updated_at, tool = sr.tool, model = sr.model, provider = sr.provider,
      input_tokens = sr.input_tokens, output_tokens = sr.output_tokens,
      cache_read_tokens = sr.cache_read_tokens, cache_write_tokens = sr.cache_write_tokens,
      thinking_tokens = sr.thinking_tokens, cost = sr.cost, cost_source = sr.cost_source,
      session_id = sr.session_key, device = sr.device, device_instance_id = sr.device_instance_id,
      platform = sr.platform,
      source_file = CASE WHEN sr.source_file != '' THEN sr.source_file ELSE records.source_file END,
      cwd = sr.cwd
    FROM synced_records sr
    WHERE sr.id = records.id
      AND records.origin = 'synced'
      AND sr.updated_at > records.updated_at
      ${ownFilter}
  `).run(params)

  const newRows = db.prepare(`
    SELECT sr.* FROM synced_records sr
    LEFT JOIN records r ON sr.id = r.id
    WHERE r.id IS NULL ${ownFilter}
  `).all(params) as Record<string, unknown>[]

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
