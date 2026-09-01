import type http from 'node:http'

export const FORCE_SHUTDOWN_TIMEOUT_MS = 1_000

interface GracefulShutdownOptions {
  server: http.Server
  cleanup: () => void
  stopRuntime: () => void
  exit?: (code: number) => void
  log?: (message: string) => void
  timeoutMs?: number
}

export function createGracefulShutdownHandler(options: GracefulShutdownOptions): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const log = options.log ?? ((message: string) => console.log(message))
  const timeoutMs = options.timeoutMs ?? FORCE_SHUTDOWN_TIMEOUT_MS
  let shuttingDown = false
  let exited = false
  let forceTimer: ReturnType<typeof setTimeout> | undefined

  const exitOnce = () => {
    if (exited) return
    exited = true
    if (forceTimer) clearTimeout(forceTimer)
    exit(0)
  }

  return () => {
    if (shuttingDown) {
      // A second signal means the caller no longer wants to wait for graceful
      // shutdown. Do not call server.close() again: each call adds another
      // close listener while active connections are still draining.
      options.server.closeAllConnections()
      exitOnce()
      return
    }
    shuttingDown = true

    log('\nShutting down...')
    options.cleanup()
    options.stopRuntime()

    forceTimer = setTimeout(() => {
      options.server.closeAllConnections()
      exitOnce()
    }, timeoutMs)
    forceTimer.unref()

    try {
      options.server.close(exitOnce)
      options.server.closeIdleConnections()
    } catch {
      exitOnce()
    }
  }
}
