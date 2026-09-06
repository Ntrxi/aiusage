import type { SyncRecord } from '@aiusage/core'
import { UNKNOWN_DEVICE_INSTANCE_ID } from '../db/records.js'

/**
 * Namespace ownership rules for the file-based sync backends (GitHub, S3, …).
 *
 * Every data file lives under `<deviceInstanceId>/YYYY/MM/DD.ndjson`; the first
 * path segment is the namespace *owner*. The invariant enforced by the
 * orchestrator is:
 *
 *   A record may only be written under the namespace of the device that
 *   parsed it, and a device only reads records that belong to the namespace
 *   they were read from.
 *
 * A line whose `deviceInstanceId` names a *different, concrete* device than
 * the namespace it sits in can only have been produced by the pre-fix bug
 * (a pulled record re-uploaded as if it were local). Its authoritative copy
 * lives in that other device's own namespace, so it is ignored on pull.
 *
 * The pre-init `'unknown'` sentinel (and an empty id from very old clients)
 * is accepted as belonging to the namespace owner — those records were
 * produced by that device before `state.json` existed.
 */

export function namespaceOwnerFromPath(path: string): string {
  const idx = path.indexOf('/')
  return idx === -1 ? path : path.slice(0, idx)
}

export type PulledRecordRejection = 'own-device-echo' | 'foreign-namespace'

/**
 * Decide whether a record read from `namespaceOwner`'s files should be stored
 * in `synced_records`. Returns `null` to accept, or the rejection reason.
 */
export function classifyPulledRecord(
  record: Pick<SyncRecord, 'deviceInstanceId'>,
  namespaceOwner: string,
  ownDeviceInstanceId: string,
): PulledRecordRejection | null {
  const did = record.deviceInstanceId
  // A copy of our own record can only come back through another namespace.
  if (did === ownDeviceInstanceId) return 'own-device-echo'
  if (!did || did === UNKNOWN_DEVICE_INSTANCE_ID) return null
  if (did !== namespaceOwner) return 'foreign-namespace'
  return null
}
