# Sync model: authoritative device namespaces

This document describes how the file-based sync backends (GitHub, S3) keep
several machines in agreement, and what changes in the release following
1.5.17 to make that reliable. It complements
[`sync-repair.md`](./sync-repair.md), which covers the opt-in cleanup of data
left behind by earlier versions.

## Layout

Every device writes only under its own namespace in the sync repository or
bucket:

```
data/<deviceInstanceId>/YYYY/MM/DD.ndjson
data/<deviceInstanceId>/manifest.json
```

`deviceInstanceId` is the UUID in `~/.aiusage/state.json`. Each line of a day
file is one wire record (`SyncRecord`), keyed by a wire id. Files are grouped
by the UTC day of the record timestamp. The manifest lists every day file of
the namespace with the digest of its canonical content; peers use it to tell
a complete snapshot from one that is being rewritten (see below).

## Target identity

Everything a device remembers about a remote store is keyed by a *sync
target* string: consent and last-sync status in `state.json`, what was
published there (`sync_record_state`), what was mirrored from there
(`sync_record_claims`) and which wire ids were retired there
(`sync_retired_wire_ids`). Two configurations therefore share a key only when
they address the same physical store:

| Configuration | Key |
| --- | --- |
| Cloud | `cloud` |
| GitHub, branch `main` (the default) | `github:<owner>/<repo>` |
| GitHub, any other branch | `github:<owner>/<repo>?branch=<branch>` |
| S3, prefix `aiusage/` on the AWS endpoint (the default) | `s3:<bucket>` |
| S3, other prefix and/or endpoint | `s3:<bucket>?prefix=<prefix>&endpoint=<endpoint>` (URL-encoded; only the non-default parts appear) |

The prefix is normalised the way the S3 backend applies it (no leading slash,
one trailing slash) and a trailing slash on the endpoint is ignored, so two
spellings of the same store get the same key. The S3 region is not part of the
key: it selects the signing region, not the store.

Clients up to 1.5.17 keyed GitHub by repository and S3 by bucket alone. A
configuration whose key changed (a non-default branch, prefix or endpoint)
adopts what was recorded under its old key the first time it syncs: consent,
last-sync status and the three bookkeeping tables are *copied* to the new key,
once, and only when the new key has nothing yet. Nothing is moved, because the
old key may also be the current key of another configuration (branch `main`
next to branch `x` of the same repository). If two configurations had been
sharing the old key, the copied claims can be broader than the store really
holds; that only delays pruning until the first reliable read of each
namespace on each target corrects them, it never deletes anything. For the
sole-target rule below, the old key counts as an alias of the new one.

## Invariants

1. **A namespace is a snapshot, not a log.** The contents of
   `data/<X>/` are exactly the records that exist in device X's local database
   with `origin = 'local'` and `device_instance_id = X`, mapped to the wire
   format. Nothing else is ever stored there.
2. **Only the owner writes.** Device X writes to and deletes from `data/<X>/`
   only. It never touches another namespace, whatever its local database
   contains (a pulled copy that lost its provenance flag is re-flagged, never
   uploaded).
3. **Peers mirror namespaces exactly, per target.** Device Y's
   `synced_records` rows attributed to X are the current contents of
   `data/<X>/`. Rows that are no longer there are removed, together with their
   merged copies in `records` (`origin = 'synced'`) — but only once *no* sync
   target claims them any more (invariant 5). Locally parsed rows are never
   deleted by sync.
4. **Wire ids are unique per device.** Every local record maps to its own wire
   id. Tools whose parser already generates a stable unique id (Antigravity,
   Trae, OpenCode, Cursor, …) publish under that id; JSONL-based tools publish
   under `sha256(device, sourceFile, lineOffset)`, which is unique because byte
   offsets are.
5. **Every pulled row is claimed by the targets it was read from.** The
   `sync_record_claims` table records, per sync target, which records of
   which namespace this device mirrored. Reconciling one target replaces only
   that target's claims. A row is deleted only when its last claim goes, so a
   record that one repository dropped but another repository (or the cloud)
   still carries is kept.
6. **Pruning only follows a namespace that was read reliably.** A namespace
   whose files could not all be read, parsed, and verified against its
   manifest is *skipped*: its lines are upserted, nothing is pruned, and the
   next sync retries. A backend that cannot list or read at all aborts the
   sync before anything is pruned.

## What a sync does

```
repairRecordProvenance        rows stamped with another device's id → origin = synced
backfillUnknownDeviceInstanceId   local rows still stamped 'unknown' → current id
prepare                       fetch remote state (git) — no-op for S3
listFiles                     one listing, reused by pull and upload (fails → sync aborts)
pull                          read every foreign namespace, upsert, then reconcile the reliable ones
merge                         synced_records → records (insert new, refresh updated)
upload                        rebuild own namespace from the local database, then its manifest
flush                         commit + push (git) — no-op for S3
```

### Pull

For each foreign namespace the orchestrator first reads
`data/<X>/manifest.json`:

* **Manifest present.** Only the day files it names are read. Each file must
  exist, every line must parse, and the digest of the file's canonical content
  must equal the digest the manifest records for it. Day files that the
  manifest does not name are ignored (they are leftovers of an interrupted
  deletion, or a file the owner has not published yet).
* **No manifest.** The namespace was last written by a client that predates
  manifests. Every listed day file is read. Such clients only ever merged
  into day files and never removed lines, so a half-written legacy namespace
  is at worst a superset of the owner's state and stays safe to reconcile
  against.

Lines are upserted into `synced_records` as they are read (a line only
replaces the stored row when its `updatedAt` is newer). Lines are ignored when
they are echoes: a `deviceInstanceId` that is a concrete id different from the
namespace owner, or this device's own id. Lines stamped `unknown` (written by a
client that had not run `aiusage init` yet) belong to the namespace owner and
are stored under the owner's id, so `unknown` never appears as a device.

Then, per namespace owner:

* if the namespace was read **reliably**, the ids collected become this
  target's claims for that owner (replacing the previous ones), and rows
  attributed to the owner that no target claims any more are deleted, with
  their merged copies;
* if it was **not** (a file listed a moment ago but gone, a malformed line, a
  manifest that does not parse or whose digests do not match), the namespace
  is skipped: claims are left as they were and nothing is pruned. `aiusage
  sync` reports the number of skipped namespaces;
* a namespace that this target claimed before but that is absent from the
  listing now was deleted remotely (the owner reset it, or the repository was
  recreated): its claims on this target are released, and its rows go if no
  other target still claims them.

Rows attributed to `unknown` that no target claims are dropped: they can only
be leftovers from a namespace that has since been republished under its real
device id.

### Upload

The orchestrator maps every local record of this device to the wire format,
groups the result by day file, and compares each file with the remote copy:

* if the backend can report content digests from its listing (S3/R2 ETags),
  a file whose digest equals the digest of the canonical content is skipped
  without being read;
* otherwise the remote file is read and compared canonically: every line must
  parse, and re-serialising the parsed records (sorted by id) must reproduce
  the canonical content byte for byte. Line order therefore does not matter,
  but a duplicated id, a malformed line, or any field difference triggers a
  rewrite.

Files that differ are written in full, **then** the manifest is written if it
changed, **then** files for days that no longer have any local record are
deleted (the manifest first, when the namespace becomes empty). Canonical
content is one JSON line per record sorted by id, so identical snapshots always
produce identical bytes and identical manifests.

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
  object by object, and an interrupted upload *can* leave the namespace
  temporarily missing a record — for example when a record's timestamp
  changed and it moved from one day file to another, the old file has already
  been rewritten without it while the new file does not exist yet. "Writes
  before deletes" does not protect against that. What does is the manifest:
  it is written only after every day file, so until then it still describes
  the previous snapshot and every peer that reads the namespace finds a
  digest mismatch, skips it, and keeps all of its rows. Once the owner's next
  sync completes, the manifest matches again and peers reconcile normally. A
  crash between the manifest and the deletions leaves extra day files that
  peers ignore because the manifest does not name them.

### Concurrency

Two devices syncing at the same time write to disjoint namespaces and each
only reads the other's. Neither can lose records of the other; at worst a
device reads a namespace mid-rewrite, sees the manifest mismatch, and
reconciles it next time.

### Backend failures

Because reconciliation deletes local rows, the backends never mask errors:

* `GitSyncBackend.readFile` returns `null` only for `ENOENT`/`ENOTDIR`;
  permission errors, I/O errors and a corrupt cache are thrown. `listFiles`
  returns an empty list only when the `data/` directory does not exist; any
  failure while walking an existing tree is thrown.
* `S3SyncBackend.readFile` returns `null` only for `NoSuchKey`/404; listing
  errors are thrown.
* A thrown listing or read error aborts the sync with `status: 'failed'`
  before any reconciliation. Lines already upserted stay (upserts are never
  destructive).
* The local database is held to the same standard: a failure while upserting
  a pulled line is never swallowed — it aborts the sync before the
  reconciliation phase — and the reconciliation of all namespaces runs in one
  transaction, so the mirror is either reconciled against a fully applied pull
  or left exactly as it was. The same holds for the cloud backend.

## Bookkeeping tables

| Table | Purpose |
| --- | --- |
| `sync_record_state` | Which local records have been published to which target, and when. Drives the `uploaded: N` count and the cloud push; the file backends always publish the full snapshot regardless. |
| `sync_record_claims` (v14) | For every sync target, the records of every foreign namespace this device mirrored from it. A pulled row is deleted only when no target claims it. The cloud backend records claims from every pull too, and a cloud tombstone releases only the cloud's claim. A claim never outlives its row: `sync --repair --apply` and `aiusage clean` drop the claims of the rows they delete. |
| `sync_retired_wire_ids` (v14) | Wire ids this device used to publish and never will again. Cleared by the next file-backend sync (the snapshot no longer contains them) or pushed as tombstones to the cloud backend. |

### The cloud backend

The cloud store is upsert-only on the way up: `push` never deletes anything,
and retired wire ids are retracted with tombstones. On the way down a pull
reads every page of the server's current generation, so a completed pull is
the authoritative list of what the cloud carries. It is reconciled exactly like
a file-based target: every device the cloud claimed before is reconciled
against what came back for it, and rows no target claims any more are removed.
When the server's data is cleared (`aiusage clean --all` advances the server's
`sync_generation`) the next pull returns neither records nor tombstones for the
old devices; their cloud claims are released and their rows go unless another
target still claims them. A tombstone from a device's own retraction likewise
releases only the cloud's claim.

## Migration from 1.5.17 and earlier

Nothing needs to be run by hand. On the first sync after upgrading:

* every device rewrites its namespace once as a canonical snapshot (old files
  had arbitrary line order and may have contained stale lines) and publishes
  its manifest;
* Antigravity and Trae records are re-published under their parser ids. Their
  old ids — under which several records had been collapsed into one — vanish
  from the namespace, and peers prune the corresponding rows on their next
  sync;
* local rows still stamped `unknown` are adopted by the current device id and
  published under it; peers stop showing an `unknown` device once every
  legacy namespace line has been replaced (the origin device's next sync does
  that) and their own next sync has pruned the old copies. For tools whose
  wire id is generated from the device id (Claude Code, Codex, …) the adoption
  changes the wire id, so rows that had already been published under
  `sha256('unknown', sourceFile, lineOffset)` have that id retired on every
  target that received it — the migration does this for rows synced before
  the upgrade, the adoption itself for any synced later — and are published
  again under the new id. The cloud copies are retracted with tombstones; file
  backends drop them with the next snapshot. Rows the previous release had
  already relabelled at parse time cannot be told apart any more, so a cloud
  copy pushed under the sentinel by 1.5.17 or earlier and never retracted is
  the one case this cannot clean up;
* rows pulled before the upgrade carry no claim. The first reliable read of
  their namespace on any target adopts them (claims are created) and prunes
  the ones the namespace no longer holds.

Rows pulled before the upgrade from a namespace that had **already
disappeared** from the target cannot be reconciled that way, because nothing
remains to read. Two things cover them:

* when the target is the only one this device has ever synced with (the usual
  case), such rows can only be stale and are pruned automatically;
* otherwise they are left alone, because they may have arrived through
  another target that still carries them. `aiusage sync --repair` lists them
  as *orphaned* pulled rows (device absent from this target, claimed by no
  target) and removes them with `--apply`. If the device does still publish
  on another target, sync that target first: it re-establishes the claims and
  repair no longer reports the rows.

Known limitation for multi-target users upgrading: rows pulled before the
upgrade through target B, from a device whose namespace on target A is stale,
are pruned by the first post-upgrade sync of A (they hold no claim yet) and
come back on the next sync of B. Records are never lost, but totals may dip
between those two syncs. Syncing every target once after upgrading settles
the claims.

Peers running an older version keep whatever rows they already have; they do
not prune, and they never write manifests. Their namespaces are still read
and reconciled (legacy mode). Upgrade every device for totals to converge.

The cloud backend stores records per device as upserts. The migration records
the retired Antigravity/Trae ids (and the sentinel ids of legacy `unknown`
rows) and the next cloud sync pushes them as tombstones, which other devices
apply on pull. Pulls are reconciled as described under *The cloud backend*
above; the push side keeps its existing semantics (no snapshot replacement).

A configuration whose target key changed with this release (non-default
branch, prefix or endpoint, see *Target identity*) adopts the consent,
bookkeeping and claims recorded under its old key on its first sync, so it
does not start from the pre-upgrade state described above.

## Diagnostics

`aiusage sync` prints, besides pulled/merged/uploaded, `pruned: N removed
remotely` (rows dropped because their owner no longer publishes them) and
`retired: N stale remote` (lines removed from this device's own namespace),
and notes how many namespaces were skipped because they could not be verified.
`aiusage sync --repair` reports stale and duplicated lines in this device's
namespace, orphaned pulled rows, and any wire-id collisions among local
records, see [`sync-repair.md`](./sync-repair.md).
