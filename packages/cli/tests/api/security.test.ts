import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import Database from 'better-sqlite3'
import { initializeDatabase } from '../../src/db/index.js'
import { createApiServer } from '../../src/api/server.js'
import { queryAllQuotas } from '../../src/quota.js'
import { loadConfig } from '../../src/config.js'

vi.mock('../../src/config.js', async (original) => ({
  ...await original<typeof import('../../src/config.js')>(),
  loadConfig: vi.fn(() => null),
  saveConfig: vi.fn(),
}))
vi.mock('../../src/quota.js', () => ({ queryAllQuotas: vi.fn(async () => [{ tool: 'codex', success: true }]) }))

describe('local API trust boundary', () => {
  let db: Database.Database
  let server: http.Server
  let base: string
  const refresh = vi.fn(async () => ({ parsedCount: 0 }))

  async function start(password = '') {
    vi.stubEnv('AIUSAGE_DASHBOARD_PASSWORD', password)
    server = createApiServer(db, { onRefresh: refresh })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as any).port}`
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(loadConfig).mockReturnValue(null)
    db = new Database(':memory:')
    initializeDatabase(db)
  })
  afterEach(async () => {
    server?.closeAllConnections()
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
    vi.unstubAllEnvs()
  })

  it('allows local native clients and same-origin dashboard requests without CORS headers', async () => {
    await start()
    for (const headers of [{}, { Origin: base }]) {
      const response = await fetch(`${base}/api/config`, { headers })
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    const response = await fetch(`${base}/api/refresh`, { method: 'POST', headers: { Origin: base } })
    expect(response.status).toBe(200)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it.each(['https://evil.example', 'null', 'http://localhost:9999'])('rejects origin %s before reads, writes, login, or preflight', async (origin) => {
    await start()
    for (const [method, route] of [['GET', '/api/config'], ['POST', '/api/refresh'], ['POST', '/api/auth/login'], ['OPTIONS', '/api/config']]) {
      const response = await fetch(`${base}${route}`, { method, headers: { Origin: origin } })
      expect(response.status).toBe(403)
      expect(response.headers.get('access-control-allow-origin')).toBeNull()
      expect(response.headers.get('access-control-allow-methods')).toBeNull()
    }
    expect(refresh).not.toHaveBeenCalled()
  })

  it('rejects a rebinding Host even when Origin matches it', async () => {
    await start()
    const response = await fetch(`${base}/api/config`, { headers: { Host: 'evil.example', Origin: 'http://evil.example' } })
    expect(response.status).toBe(403)
  })

  it('rejects cross-site requests without Origin and prevents GET refresh side effects', async () => {
    await start()
    expect((await fetch(`${base}/api/refresh`, { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403)
    const response = await fetch(`${base}/api/refresh`)
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('requires authentication for quotas and adjacent APIs, including session IDs ending in asset extensions', async () => {
    await start('secret')
    for (const route of ['/api/quotas', '/api/config', '/api/config/credentials/status', '/api/config/credential?ref=token', '/api/cli/sync/status', '/api/sessions/session.json', '/api/detected-tools']) {
      expect((await fetch(`${base}${route}`)).status).toBe(401)
    }
    expect(queryAllQuotas).not.toHaveBeenCalled()
    expect((await fetch(`${base}/api/summary?range=day`)).status).toBe(200)
    const wrong = await fetch(`${base}/api/auth/login`, { method: 'POST', body: JSON.stringify({ password: 'wrong' }) })
    expect(wrong.status).toBe(401)
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { Origin: base }, body: JSON.stringify({ password: 'secret' }) })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    const response = await fetch(`${base}/api/quotas`, { headers: { Cookie: cookie } })
    expect(response.status).toBe(200)
    expect(queryAllQuotas).toHaveBeenCalledOnce()
    expect((await fetch(`${base}/api/quotas`, { headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status).toBe(403)
    expect(queryAllQuotas).toHaveBeenCalledOnce()
  })

  it('retains passwordless local quota access', async () => {
    await start()
    expect((await fetch(`${base}/api/quotas`)).status).toBe(200)
  })

  it('never reveals configured secrets or references even to an authenticated browser', async () => {
    vi.mocked(loadConfig).mockReturnValue({
      sync: { backend: 'github', repo: 'owner/repo', credentialRef: 'PRIVATE_REF' },
      credentials: { 'github/owner/repo/token': 'stored-secret', PRIVATE_REF: 'other-secret' },
    })
    await start('secret')
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', body: JSON.stringify({ password: 'secret' }) })
    const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0], Origin: base }
    for (const route of ['/api/config', '/api/config/credentials/status?backend=github&repo=owner/repo']) {
      const response = await fetch(base + route, { headers })
      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).toContain('"githubToken":true')
      for (const secret of ['stored-secret', 'other-secret', 'PRIVATE_REF', 'credentialRef', 'credentialKeys']) expect(body).not.toContain(secret)
    }
    expect((await fetch(`${base}/api/config/credential?ref=PRIVATE_REF`, { headers })).status).toBe(404)
  })
})
