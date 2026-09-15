# Sync model: authoritative device namespaces

This document describes how the file-based sync backends (GitHub, S3) keep
several machines in agreement, and what changed in 1.5.17 to make that
reliable. It complements [`sync-repair.md`](./sync-repair.md), which covers the
opt-in cleanup of data left behind by earlier versions.

## Layout

Every device writes only under its own namespace in the sync repository or
bucket:

```
data/<deviceInstanceId>/YYYY/MM/DD.ndjson
```

`deviceInstanceId` is the UUID in `~/.aiusage/state.json`. Each line is one
wire record (`SyncRecord`), keyed by a wire id. Files are grouped by the UTC
day of the record timestamp.

## Invariants

1. **A namespace is a snapshot, not a log.** The contents of
   `data/<X>/` are exactly the records that exist in device X's local database
   with `origin = 'local'` and `device_instance_id = X`, mapped to the wire
   format. Nothing else is ever stored there.
2. **Only the owner writes.** Device X writes to and deletes from `data/<X>/`
   only. It never touches another namespace, whatever its local database
   contains (a pulled copy that lost its provenance flag is re-flagged, never
   uploaded).
3. **Peers mirror namespaces exactly.** Device Y's `synced_records` rows
   attributed to X are the current contents of `data/<X>/`. Rows that are no
   longer there are removed, together with their merged copies in `records`
   (`origin = 'synced'`). Locally parsed rows are never deleted by sync.
4. **Wire ids are unique per device.** Every local record maps to its own wire
   id. Tools whose parser already generates a stable unique id (Antigravity,
   Trae, OpenCode, Cursor, …) publish under that id; JSONL-based tools publish
   under `sha256(device, sourceFile, lineOffset)`, which is unique because byte
   offsets are.

## What a sync does

```
repairRecordProvenance        rows stamped with another device's id → origin = synced
backfillUnknownDeviceInstanceId   local rows still stamped 'unknown' → current id
prepare                       fetch remote state (git) — no-op for S3
listFiles                     one listing, reused by pull and upload
pull                          read every foreign namespace, upsert, then reconcile
merge                         synced_records → records (insert new, refresh updated)
upload                        rebuild own namespace from the local database
flush                         commit + push (git) — no-op for S3
```

### Pull

For each foreign namespace the orchestrator reads every file, collects the set
of ids present, and upserts each line into `synced_records` (a line only
replaces the stored row when its `updatedAt` is newer). Lines are ignored when
they are echoes: a `deviceInstanceId` that is a concrete id different from the
namespace owner, or this device's own id. Lines stamped `unknown` (written by a
client that had not run `aiusage init` yet) belong to the namespace owner and
are stored under the owner's id, so `unknown` never appears as a device.

Then, per namespace owner, `synced_records` rows attributed to the owner whose
id is not in the collected set are deleted, and so are their merged copies. A
namespace that was seen on this sync target before but is absent now (the
owner reset it, or the repository was recreated) is pruned entirely. Namespaces
are remembered per target in `sync_namespaces`, so switching from one
repository or bucket to another never prunes rows that arrived through the
other target.

### Upload

The orchestrator maps every local record of this device to the wire format,
groups the result by day file, and compares each file with the remote copy:

* if the backend can report content digests from its listing (S3/R2 ETags),
  a file whose digest equals the digest of the canonical content is skipped
  without being read;
* otherwise the remote file is read and compared record by record, ignoring
  line order (so files written by older versions are not rewritten unless a
  record actually changed).

Files that differ are written in full; files for days that no longer have any
local record are deleted afterwards. Canonical content is one JSON line per
record sorted by id, so identical snapshots always produce identical bytes.

A sync with no local changes therefore performs no writes. With the GitHub
backend nothing is committed or pushed; with S3 no `PutObject` is issued.

### Atomicity and interruptions

* **GitHub**: all writes and deletions land in one commit, pushed once. An
  interrupted sync leaves the previous commit in place; the next sync
  re-clones or resets the cache to the remote branch and recomputes the
  snapshot from scratch. A push rejected because a peer pushed first is
  retried after `pull --rebase`; namespaces never overlap, so the rebase
  cannot conflict.
* **S3**: each object write is atomic, but the namespace as a whole is written
  file by file. Writes happen before deletions, so an interruption can leave a
  superset of the intended snapshot (some old day files still present), never
  a subset. The next sync completes the replacement. Peers that pull in
  between may briefly see a stale record that disappears on their next sync.

### Concurrency

Two devices syncing at the same time write to disjoint namespaces and each
only reads the other's. Neither can lose records of the other; at worst a
device reads a namespace mid-rewrite (S3) and reconciles again next time.

## Bookkeeping tables

| Table | Purpose |
| --- | --- |
| `sync_record_state` | Which local records have been published to which target, and when. Drives the `uploaded: N` count and the cloud push; the file backends always publish the full snapshot regardless. |
| `sync_namespaces` (v14) | Foreign namespaces seen per target, so that a namespace deleted remotely is pruned locally and namespaces of other targets are left alone. |
| `sync_retired_wire_ids` (v14) | Wire ids this device used to publish and never will again. Cleared by the next file-backend sync (the snapshot no longer contains them) or pushed as tombstones to the cloud backend. |

## Migration from 1.5.16 and earlier

Nothing needs to be run by hand. On the first sync after upgrading:

* every device rewrites its namespace once as a canonical snapshot (old files
  had arbitrary line order and may have contained stale lines);
* Antigravity and Trae records are re-published under their parser ids. Their
  old ids — under which several records had been collapsed into one — vanish
  from the namespace, and peers prune the corresponding rows on their next
  sync;
* local rows still stamped `unknown` are adopted by the current device id and
  published under it; peers stop showing an `unknown` device once every
  legacy namespace line has been replaced (the origin device's next sync does
  that) and their own next sync has pruned the old copies.

Peers running an older version keep whatever rows they already have; they do
not prune. Upgrade every device for totals to converge.

The cloud backend stores records per device as upserts. The migration records
the retired Antigravity/Trae ids and the next cloud sync pushes them as
tombstones, which other devices apply on pull. Cloud sync otherwise keeps its
existing semantics (no snapshot replacement).

## Diagnostics

`aiusage sync` prints, besides pulled/merged/uploaded, `pruned: N removed
remotely` (rows dropped because their owner no longer publishes them) and
`retired: N stale remote` (lines removed from this device's own namespace).
`aiusage sync --repair` reports stale and duplicated lines in this device's
namespace and any wire-id collisions among local records, see
[`sync-repair.md`](./sync-repair.md).
