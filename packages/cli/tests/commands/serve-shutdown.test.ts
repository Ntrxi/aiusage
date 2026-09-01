import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGracefulShutdownHandler } from '../../src/commands/serve-shutdown.js'

function createServer() {
  return {
    close: vi.fn(),
    closeIdleConnections: vi.fn(),
    closeAllConnections: vi.fn(),
  }
}

describe('createGracefulShutdownHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('cleans up and exits after the server closes', () => {
    const server = createServer()
    server.close.mockImplementation((callback: () => void) => {
      callback()
      return server
    })
    const cleanup = vi.fn()
    const stopRuntime = vi.fn()
    const exit = vi.fn()
    const log = vi.fn()
    const shutdown = createGracefulShutdownHandler({
      server: server as any,
      cleanup,
      stopRuntime,
      exit,
      log,
    })

    shutdown()

    expect(log).toHaveBeenCalledWith('\nShutting down...')
    expect(cleanup).toHaveBeenCalledOnce()
    expect(stopRuntime).toHaveBeenCalledOnce()
    expect(server.close).toHaveBeenCalledOnce()
    expect(server.closeIdleConnections).toHaveBeenCalledOnce()
    expect(server.closeAllConnections).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('force-closes active connections when graceful shutdown times out', () => {
    const server = createServer()
    server.close.mockReturnValue(server)
    const exit = vi.fn()
    const shutdown = createGracefulShutdownHandler({
      server: server as any,
      cleanup: vi.fn(),
      stopRuntime: vi.fn(),
      exit,
      log: vi.fn(),
      timeoutMs: 100,
    })

    shutdown()
    vi.advanceTimersByTime(99)
    expect(exit).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(server.closeAllConnections).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('force-exits on a second signal without calling server.close again', () => {
    const server = createServer()
    server.close.mockReturnValue(server)
    const cleanup = vi.fn()
    const stopRuntime = vi.fn()
    const exit = vi.fn()
    const shutdown = createGracefulShutdownHandler({
      server: server as any,
      cleanup,
      stopRuntime,
      exit,
      log: vi.fn(),
    })

    shutdown()
    shutdown()

    expect(cleanup).toHaveBeenCalledOnce()
    expect(stopRuntime).toHaveBeenCalledOnce()
    expect(server.close).toHaveBeenCalledOnce()
    expect(server.closeAllConnections).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
  })
})
