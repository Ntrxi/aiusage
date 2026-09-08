import type http from 'node:http'
import { isIP } from 'node:net'

export const DEFAULT_DASHBOARD_HOST = '127.0.0.1'

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost') return true
  if (isIP(normalized) === 4) return normalized.startsWith('127.')
  if (isIP(normalized) === 6) {
    return new URL(`http://[${normalized}]`).hostname === '[::1]'
  }
  return false
}

export function dashboardHost(host: string | undefined, password: string | null): string {
  const value = host ?? DEFAULT_DASHBOARD_HOST
  if (!value || value !== value.trim()) throw new Error('Invalid dashboard host')
  const normalized = value.replace(/^\[|\]$/g, '')
  if (normalized !== value && (isIP(normalized) !== 6 || value !== `[${normalized}]`)) throw new Error('Invalid dashboard host')
  if (!isLoopbackHost(value) && !password) {
    throw new Error('Non-loopback --host requires AIUSAGE_DASHBOARD_PASSWORD to be set')
  }
  // Resolve localhost deterministically rather than trusting DNS/hosts-file overrides.
  return normalized.toLowerCase() === 'localhost' ? DEFAULT_DASHBOARD_HOST : normalized
}

/** Same-origin browser requests only; native clients may omit Origin. */
export function isTrustedApiRequest(req: http.IncomingMessage, password: string | null): boolean {
  try {
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return false
    new URL(req.url, 'http://localhost')
    const host = req.headers.host
    if (!host || /[\s/@\\?#]/.test(host)) return false
    const target = new URL(`http://${host}`)
    // Prevent DNS rebinding against the passwordless loopback service.
    if (!password && !isLoopbackHost(target.hostname)) return false
    if (req.headers['sec-fetch-site'] === 'cross-site') return false
    const origin = req.headers.origin
    if (origin !== undefined) {
      const source = new URL(origin)
      // HTTPS is allowed for a reverse proxy preserving the external Host.
      if (!['http:', 'https:'].includes(source.protocol) || source.host !== target.host || source.origin !== origin) return false
    }
    return true
  } catch {
    return false
  }
}
