import { describe, it, expect } from 'vitest'
import { classifyPulledRecord, namespaceOwnerFromPath } from '../../src/sync/ownership.js'
import { isUploadableLocalRecord } from '../../src/db/records.js'

describe('namespace ownership', () => {
  it('derives the namespace owner from the first path segment', () => {
    expect(namespaceOwnerFromPath('device-a/2026/09/06.ndjson')).toBe('device-a')
    expect(namespaceOwnerFromPath('device-a')).toBe('device-a')
  })

  it('accepts records that belong to the namespace they were read from', () => {
    expect(classifyPulledRecord({ deviceInstanceId: 'device-a' }, 'device-a', 'device-me')).toBeNull()
    expect(classifyPulledRecord({ deviceInstanceId: 'unknown' }, 'device-a', 'device-me')).toBeNull()
    expect(classifyPulledRecord({ deviceInstanceId: '' as string }, 'device-a', 'device-me')).toBeNull()
  })

  it('rejects echoes of our own records and lines from a foreign device', () => {
    expect(classifyPulledRecord({ deviceInstanceId: 'device-me' }, 'device-a', 'device-me')).toBe('own-device-echo')
    expect(classifyPulledRecord({ deviceInstanceId: 'device-b' }, 'device-a', 'device-me')).toBe('foreign-namespace')
  })
})

describe('isUploadableLocalRecord', () => {
  it('allows only local rows stamped with this device (or the pre-init sentinel)', () => {
    expect(isUploadableLocalRecord({ origin: 'local', deviceInstanceId: 'me' }, 'me')).toBe(true)
    expect(isUploadableLocalRecord({ origin: undefined, deviceInstanceId: 'me' }, 'me')).toBe(true)
    expect(isUploadableLocalRecord({ origin: 'local', deviceInstanceId: 'unknown' }, 'me')).toBe(true)
    expect(isUploadableLocalRecord({ origin: 'synced', deviceInstanceId: 'me' }, 'me')).toBe(false)
    expect(isUploadableLocalRecord({ origin: 'local', deviceInstanceId: 'other' }, 'me')).toBe(false)
    expect(isUploadableLocalRecord({ origin: 'synced', deviceInstanceId: 'other' }, 'me')).toBe(false)
  })
})
