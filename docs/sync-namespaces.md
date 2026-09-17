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
last-sync status, publish bookkeeping, claims and retired wire ids are
*copied* to the new key, once, and only when the new key has nothing yet.
Nothing is moved, because the old key may also be the current key of another
configuration (branch `main` next to branch `x` of the same repository). If
two configurations had been sharing the old key, the copied claims can be
broader than the store really holds; that only delays pruning until the first
reliable read of each namespace on each target corrects them, it never
deletes anything. Namespace verdicts are not copied: a verdict permits
deletion, and one recorded under the old key was made by whichever
configuration synced under it. For the same reason the old key stays among
the known targets of invariant 8 — nothing recorded locally tells whether the
rows it claims came from this configuration before the upgrade or from the
other one, so the new key alone must not settle them. If the old key really
was only ever this configuration's, it is a target that is never synced again
(see *Migration* below): unresolved rows wait for a verdict it never records,
and its claims keep every row they name — including the old Antigravity/Trae
wire ids this release retires — because only a sync under the old key could
release them. Nothing recorded locally can tell the two cases apart, so
nothing expires the key on its own; `aiusage clean --all` is the only
automatic path that drops claims, and it wipes everything. The explicit way
out is `aiusage sync --repair --forget-target <old key>` (dry run; `--apply`
performs it): it deletes the key's claims, verdicts, publish bookkeeping and
retired wire ids in one transaction, marks the rows that thereby lost their
last claim unresolved at the tick taken before the change, and then removes
the key from `state.json`. It deletes no record itself — the released rows go
through the normal prune once every remaining known target has synced again —
and it refuses the configured key and keys nothing is recorded under. See
[`sync-repair.md`](./sync-repair.md).

## Invariants

These are the rules every code path (sync, cloud sync, `clean`, `--repair`)
is held to; the scenario matrix at the end names the test that locks each one
down.

1. **A namespace is a snapshot, not a log.** The contents of
   `data/<X>/` are exactly the records that exist in device X's local database
   with `origin = 'local'` and `device_instance_id = X`, mapped to the wire
   format. Nothing else is ever stored there.
2. **Only the owner writes.** Device X writes to and deletes from `data/<X>/`
   only. It never touches another namespace, whatever its local database
   contains (a pulled copy that lost its provenance flag is re-flagged, never
   uploaded).
3. **Wire ids are unique per device.** Every local record maps to its own wire
   id. Tools whose parser already generates a stable unique id (Antigravity,
   Trae, OpenCode, Cursor, …) publish under that id; JSONL-based tools publish
   under `sha256(device, sourceFile, lineOffset)`, which is unique because byte
   offsets are.
4. **Every pulled row has a provenance.** A `synced_records` row is either
   *claimed* — `sync_record_claims` names the targets whose verified snapshot
   of the owner's namespace contained it when last read — or *unresolved*:
   `unclaimed_since` is set and no target claims it, because it was pulled
   before claims existed (migration v14) or read from a namespace that no
   target has verified since. There is no third state.
5. **A target only ever releases its own claim.** Reconciling a target
   replaces that target's claims for a namespace and touches no other
   target's. A cloud tombstone releases the cloud's claim only; a row the
   cloud never claimed is not touched by it.
6. **A row is deleted only when no target claims it**, and only in one of two
   ways: the target that held its last claim released it because its verified
   snapshot no longer contains the record, or the row is unresolved and every
   known target has judged it absent (invariant 8). Locally parsed rows are
   never deleted by sync.
7. **Peers mirror namespaces exactly, per target.** After a reliable read of
   `data/<X>/` on target T, T's claims for X are exactly the ids the namespace
   holds; rows X no longer publishes on T lose T's claim (and go if that was
   the last one), together with their merged copies in `records`.
8. **Unresolved rows are settled by verdicts, never by a single target.**
   `sync_namespace_verdicts` records, per target and namespace owner, the
   *sync tick* at which the target last judged that namespace reliably — a
   verified snapshot, an authoritatively empty namespace, or a confirmed
   absence. An unresolved row is deleted only once every target this device
   knows (every key in `state.json`, the current one included) has a verdict
   for its namespace from a sync *after* the one that made the row
   unresolved, and still none claims it. Ticks come from the sync clock: each
   sync run takes a tick one greater than any recorded so far, stamps the rows
   it upserts unresolved with it and records its verdicts under it, so the
   sync that read a row can never be the one that judges it absent.
9. **Only a verified authoritative snapshot can cause deletions.** A
   namespace whose files could not all be read, parsed and verified against
   its manifest is *skipped*: its lines are upserted (a new row is
   unresolved; an existing row is refreshed only by a newer version), no claim
   is touched, nothing is pruned, no verdict is recorded. A backend that
   cannot list or read at all aborts the sync before anything is reconciled.
10. **"Absent", "authoritatively empty" and "unverifiable" are distinct
    states** of a namespace with no listed day file: no manifest means the
    namespace was deleted; a valid manifest naming no file means the owner
    published an empty snapshot; a manifest naming files that are gone, or one
    that does not parse, means nothing can be concluded. The first two are
    reconciled against the empty set; the third is skipped.
11. **Interrupted operations never create false absence.** A Git cache with a
    file where a directory should be, a permission error, an S3 object that
    vanished between listing and reading, a `DeleteObjects` that deleted only
    some keys, a cloud pull whose pages span two generations, an upload
    interrupted between day files and manifest — each surfaces as a failure or
    an unverifiable namespace, never as "the records are gone".
12. **The local value of a record is the newest version ever observed.**
    Claims track *which targets carry* a record; its payload is global and
    last-writer-wins on `updatedAt`, whatever target or snapshot it came from.
    If target A carries `r@v2` and target B `r@v1`, the local row is v2; if A
    then drops the record, B's claim keeps the row and it stays v2. Exact
    per-target mirroring of payloads is deliberately not attempted.
13. **Migration converges, and nothing is protected forever.** Rows that
    predate claims are unresolved at tick 0 and settle as soon as every known
    target has synced once; a target that will never be synced again keeps
    withholding its verdict, and `aiusage sync --repair` is the deterministic
    way to remove what the configured target provably does not carry.

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

Upserting is deliberately *additive* and happens whether or not the namespace
turns out to be reliable: an upsert only ever adds or refreshes a row, a row
added from a half-published snapshot carries no claim until the first reliable
read (which then keeps or prunes it), and withholding the lines would hide a
namespace whose owner crashed mid-rewrite and never came back. The manifest is
therefore the commit boundary for **pruning**, not for additions.

The namespaces read are not only the ones with day files in the listing:
every namespace this target claimed before, and every namespace that
unresolved rows are attributed to, is planned through its manifest too. The
listing only shows day files, so for a namespace with none the manifest is
what tells the three states apart (invariant 10):

| `data/<X>/` on the target | State | Effect |
| --- | --- | --- |
| no day files, no manifest | **absent** — deleted remotely (the owner reset it, the repository was recreated) | reconciled against the empty set |
| no day files, valid manifest naming no file | **authoritatively empty** — the owner published an empty snapshot | reconciled against the empty set |
| no day files, manifest naming files | **unverifiable** — the owner is mid-publish, or the files were lost | skipped |
| manifest that does not parse | **unverifiable** | skipped |

Then, per namespace owner:

* if the namespace was read **reliably**, the ids collected become this
  target's claims for that owner (replacing the previous ones), rows whose
  claim this released and that no target claims any more are deleted with
  their merged copies, and the verdict `(target, owner, tick)` is recorded;
* if it was **not** (a file listed a moment ago but gone, a malformed line, a
  manifest that does not parse or whose digests do not match, a manifest
  naming files that are not there), the namespace is skipped: claims are left
  as they were, nothing is pruned, no verdict is recorded. `aiusage sync`
  reports the number of skipped namespaces.

Rows attributed to `unknown` (lines an old client wrote before `aiusage init`,
mirrored before this release) can sit in any namespace of the target — a
reliable read relabels them to its owner and claims them — so the target's
verdict on them is recorded only in a sync during which every namespace on the
target was read reliably.

Finally, unresolved rows whose namespace every known target has judged since
they became unresolved, and that still no target claims, are deleted
(invariant 8). Everything else unresolved waits.

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
deleted. A namespace that becomes empty publishes an *empty* manifest first,
deletes its day files, and removes the manifest last, so at no point does a
peer find leftover day files without a manifest (which it would read as a
legacy namespace and keep mirroring). Canonical content is one JSON line per
record sorted by id, so identical snapshots always produce identical bytes and
identical manifests.

A sync with no local changes therefore performs no writes. With the GitHub
backend nothing is committed or pushed; with S3 no `PutObject` is issued.

### Remote cleanup and repair

`aiusage clean --before <days>` also removes records from the remote day files
of every namespace, and `aiusage sync --repair --apply` rewrites files of this
device's namespace (with `--all-namespaces`, of every namespace). Both read a
namespace exactly as pull does — through its manifest — and **only modify a
namespace whose snapshot they could verify**: manifest parsed, every named
file present, every line parsing, every digest matching (for a legacy
namespace without a manifest: every listed file parsing). Anything else is
skipped and reported (`clean` prints the namespaces it left untouched;
`--repair` lists them as *NOT verified*), because a manifest published over a
half-written or corrupt state would make that state authoritative for every
peer. A malformed line is never silently dropped by a rewrite. Day files a
manifest does not name are leftovers of an interrupted deletion by the owner
and are not touched either.

Within a namespace the kept records are rewritten in canonical form, **then**
the manifest is refreshed to name exactly the files that remain (an empty
manifest when the namespace empties out), **then** day files left without a
record are deleted. An interrupted cleanup therefore leaves a namespace peers
either skip (the previous manifest no longer matches) or mirror correctly. A
namespace without a manifest — still written by a pre-manifest client — does
not acquire one, since that client would never maintain it.

Cleaning or repairing a namespace one does not own has no transaction on S3:
the owner may publish between the read and the writes. Verification bounds
what can happen. Every file the cleanup writes derives from the one snapshot
it verified, and the manifest it writes records the digests of those files
and of the verified files it left alone, so it can only ever describe *that
snapshot minus the removed lines*. A file the owner wrote in the same window
either stays (its digest no longer matches: peers skip the namespace and
prune nothing) or is overwritten by the cleanup's version (peers reconcile
against the verified snapshot minus the removed lines). Either way the
owner's next sync republishes the namespace from its local database and
settles it. A namespace is a snapshot of its owner's database, so cleaning
another device's namespace is durable only for a device that no longer
syncs; an active owner that has not run `aiusage clean --before` itself
restores the records on its next sync. On GitHub a concurrent push by the
owner simply makes the cleanup's push fail (`pull --rebase` conflicts on the
shared files), and nothing is published.

`aiusage clean --all` wipes the whole target with `deleteAllData`, always —
the listing only shows day files, and an interrupted operation can leave a
namespace consisting of nothing but its `manifest.json`, which peers would
otherwise keep reading as an empty snapshot. A full local clean also drops
pending retired wire ids along with claims, sync state and tombstones.

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
reconciles it next time. The only writers that cross namespaces are remote
cleanup and `--repair --all-namespaces`; see *Remote cleanup and repair* for
what bounds them.

### Backend failures

Because reconciliation deletes local rows, the backends never mask errors:

* `GitSyncBackend.readFile` returns `null` only for `ENOENT`, the one errno
  that confirms absence. `ENOTDIR` (a file where a directory is expected)
  means the cache layout is corrupt and is thrown like permission and I/O
  errors. `listFiles` returns an empty list only when the `data/` directory
  does not exist; any failure while inspecting or walking it is thrown.
* `S3SyncBackend.readFile` returns `null` only for `NoSuchKey`/404; listing
  errors are thrown. `deleteAllData` inspects the per-object `Errors` of every
  `DeleteObjects` response and throws when any key was not deleted, so
  `aiusage clean --all` never reports a partial wipe as complete.
* A thrown listing or read error aborts the sync with `status: 'failed'`
  before any reconciliation.
* The local database is held to the same standard: a failure while upserting
  a pulled line is never swallowed — it aborts the sync before the
  reconciliation phase. What was upserted before the failure stays: an upsert
  only adds an unresolved row, which no reconciliation can delete until every
  known target has judged its namespace, or refreshes a row with a newer
  version of itself. The reconciliation of all namespaces then runs in one
  transaction, so claims, verdicts and deletions land for every reliable
  namespace or for none. The pull as a whole is therefore *additive-then-
  atomic*, not atomic: a sync that fails after upserting may leave new
  unresolved rows behind, and the next successful sync settles them. The same
  holds for the cloud backend.

## Bookkeeping tables

| Table | Purpose |
| --- | --- |
| `sync_record_state` | Which local records have been published to which target, and when. Drives the `uploaded: N` count and the cloud push; the file backends always publish the full snapshot regardless. |
| `sync_record_claims` (v14) | For every sync target, the records of every foreign namespace this device mirrored from it. A pulled row is deleted only when no target claims it. The cloud backend records claims from every pull too, and a cloud tombstone releases only the cloud's claim. A claim never outlives its row: `sync --repair --apply` and `aiusage clean` drop the claims of the rows they delete. Only `aiusage clean --all` and `sync --repair --forget-target <key> --apply` drop claims wholesale; the latter for one key, turning the rows that lose their last claim into unresolved rows instead of deleting them. |
| `synced_records.unclaimed_since` (v14) | The sync tick at which a row became unresolved (no target claims it); `NULL` once a target claims it. Rows that predate the column carry tick 0. Forgetting a target stamps the rows it was the last claimant of with the tick taken before the forget, so only a later sync can judge them. |
| `sync_namespace_verdicts` (v14) | For every sync target and namespace owner, the sync tick at which the target last judged the namespace reliably. Unresolved rows are deleted only once every known target has a verdict for their namespace from a later tick. Cleared by `aiusage clean --all` and, for one key, by `--forget-target`; never copied when a target key is adopted. |
| `sync_retired_wire_ids` (v14) | Wire ids this device used to publish and never will again. Cleared by the next file-backend sync (the snapshot no longer contains them) or pushed as tombstones to the cloud backend. `--forget-target` drops the forgotten key's entries: nothing will sync under it, so nothing would ever tombstone them. |
| `state.json` (`syncConsents`, `syncTargets`, `lastSyncTarget`) | The keys `knownSyncTargets` counts. Every key listed here must record a verdict before unresolved rows are pruned. A key is removed only by `--forget-target --apply`, after the database part committed, so a crash in between leaves the key known (nothing pruned early) and a re-run completes the forget. |

### The cloud backend

The cloud store is upsert-only on the way up: `push` never deletes anything,
and retired wire ids are retracted with tombstones. On the way down a pull
reads every page of the server's current generation, so a completed pull is
the authoritative list of what the cloud carries. The generation is pinned by
the first page: if a later page reports another one, the server's data was
cleared mid-pull and the pull starts over (a pull that cannot observe one
stable generation fails rather than stitching two generations into one
snapshot). The pushes that follow go out under the generation the pull
observed, so a client that last synced before the server was cleared is not
rejected as stale. A completed pull is reconciled exactly like a file-based
target: every device the cloud claimed before is reconciled against what came
back for it, and rows no target claims any more are removed.
When the server's data is cleared (`aiusage clean --all` advances the server's
`sync_generation`) the next pull returns neither records nor tombstones for the
old devices; their cloud claims are released and their rows go unless another
target still claims them. A tombstone from a device's own retraction likewise
releases only the cloud's claim, and never touches a row the cloud does not
claim. A completed pull is also the cloud's verdict on every namespace —
including those it returned nothing for, and the legacy `unknown` rows — so
unresolved rows are settled by the cloud exactly as by a file target.

The cloud API has its own record shape, and `sync/cloud-dto.ts` is the only
place that knows it: the server stores the device alias as `device_name` and
serialises it as `deviceName` on both push and pull, where the core
`SyncRecord` (the file backends' wire format and the local tables) calls it
`device`; integer columns are Postgres bigints and come back as strings.
Records go out through `toCloudRecord` and come in through `fromCloudRecord`,
which normalises numbers and rejects a record that lacks a wire id, an origin
device, a tool, a model or its timestamps — and a pull containing such a
record fails rather than silently omitting it, because a completed pull is
reconciled against and an omission would read as absence. Ownership is not
part of the translation: `deviceInstanceId` names the origin device on both
sides.

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
* rows pulled before the upgrade carry no claim, and nothing records which
  target they came from. The migration marks them *unresolved* at sync tick
  0. A reliable read of their namespace on any target claims the ones the
  namespace holds; the others stay, unpruned, until every target this device
  knows (every key in `state.json`) has judged the namespace. With one target
  that is the first sync; with several it is the first sync of each. Syncing
  target A first therefore never deletes a row that target B still carries —
  B's sync claims it — and a row that no target carries goes exactly when the
  last of them has looked.

Rows of a device whose namespace has **already disappeared** from a target
are covered by the same rule: an absent namespace is a verdict too. Only a
target that is never synced again — a repository or bucket still recorded in
`state.json` but no longer used — withholds its verdict indefinitely. For
that case `aiusage sync --repair` lists the unresolved rows the configured
target provably does not carry (device absent, or its verified namespace
without them) as *orphaned* and removes them with `--apply`. If the device
does still publish them on another target, sync that target first: it claims
the rows and repair no longer reports them.

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
does not start from the pre-upgrade state described above. The old key
remains a known target: if no configuration syncs under it again, rows it
alone would have settled stay unresolved, and rows its claims name are never
pruned — `sync --repair` cannot see them as orphans, because they still have
a claim. Plain `aiusage sync --repair` names every key other than the
configured one as a hint; `aiusage sync --repair --forget-target <old key>
--apply` releases the key (see *Target identity*), after which the next sync
of every remaining known target settles the rows: those a target still
carries are claimed and kept, the others are pruned. Syncing under the
forgotten key later simply makes it a known target again and pulls its rows
back.

## Scenario matrix

Each row is an adversarial scenario the invariants must survive, with the
test that exercises it (all under `packages/cli/tests/`).

| Scenario | Invariants | Test |
| --- | --- | --- |
| Upgrade with two targets carrying overlapping sets; sync A first, then B, and the reverse | 1, 4, 6, 8, 13 | `sync/sync-invariants.test.ts` — *upgrading with several sync targets* |
| A known target that is never synced again; repair removes what the configured target verified absent | 8, 13 | same |
| A verdict recorded before a row became unresolved does not settle it | 8 | same |
| Namespace with no day files: absent / empty manifest / manifest naming missing files / unparsable manifest | 5, 9, 10 | `sync/sync-invariants.test.ts` — *what a namespace with no listed day file means* |
| Unverifiable snapshot with newer token data and an extra record: row updated, claims untouched, nothing pruned | 9, 12 | `sync/sync-invariants.test.ts` — *unverified snapshots* |
| A row read from an unverifiable snapshot on A is not pruned by B verifying the namespace | 5, 8, 9 | same |
| `r@v2` on A, `r@v1` on B; A drops it; B's claim keeps v2 | 6, 12 | `sync/sync-invariants.test.ts` — *one record, different versions* |
| Legacy `unknown` rows wait for a fully reliable sync of every known target | 8, 9 | `sync/sync-invariants.test.ts` — *legacy rows stamped 'unknown'* |
| Listing failure, read failure, local DB failure mid-pull, file vanished between list and read, malformed line, manifest mismatch, record moving between day files on S3, interrupted wipe | 9, 11 | `sync/reconciliation-safety.test.ts` |
| Git `ENOTDIR`, permission and I/O errors are never absence | 11 | `sync/git-fail-closed.test.ts` |
| S3 `DeleteObjects` with per-object errors | 11 | `sync/s3-delete-all.test.ts` |
| Same record on two targets; one target drops it; namespace disappears from one target only; cloud claim vs file target | 5, 6, 7 | `sync/multi-target-claims.test.ts` |
| Cloud generation reset, pages spanning two generations, tombstones for unclaimed rows | 5, 6, 11 | `sync/cloud-orchestrator-claims.test.ts`, `sync/cloud-orchestrator-tombstones.test.ts` |
| Cloud wire shape: `deviceName` on push and pull, bigint strings, unparsable record fails the pull | 11 | `sync/cloud-dto.test.ts` |
| Two branches / prefixes of one store never share claims; legacy key adoption copies claims but not verdicts; the old key stays a known target so the changed configuration never settles rows the unchanged one carries | 5, 8 | `sync/target-identity.test.ts` |
| A stray `.ndjson` file outside any namespace folder is not a namespace | 9 | `sync/reconciliation-safety.test.ts`, `sync/snapshot-listing.test.ts` |
| Migration stamps pre-existing rows at tick 0; idempotent | 4, 13 | `db/migration-v14.test.ts` |
| Cleanup and repair only rewrite verified namespaces | 9 | `commands/clean-remote.test.ts`, `sync/repair-verify.test.ts` |
| Forgetting an abandoned key: rows only it claimed (including a retired Antigravity wire id) become unresolved at the pre-change tick and go only with the next sync of every remaining target; rows the current target claims are untouched; dry run changes nothing; refuses the current and unknown keys; idempotent, crash between DB commit and state write completed by a re-run with nothing pruned early; adoption copies nothing back; syncing under the key again pulls its rows back; plain `--repair` only names the key | 3, 4, 13 | `sync/forget-target.test.ts`, `commands/sync.test.ts` |

## Diagnostics

`aiusage sync` prints, besides pulled/merged/uploaded, `pruned: N removed
remotely` (rows dropped because their owner no longer publishes them) and
`retired: N stale remote` (lines removed from this device's own namespace),
and notes how many namespaces were skipped because they could not be verified.
`aiusage sync --repair` reports stale and duplicated lines in this device's
namespace, namespaces it could not verify, orphaned pulled rows (unresolved
rows the configured target provably does not carry), and any wire-id
collisions among local records, see [`sync-repair.md`](./sync-repair.md).
