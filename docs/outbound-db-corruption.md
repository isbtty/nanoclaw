# outbound.db corruption — detection, recovery, containment

How the host and the agent-runner cooperate when a session's `outbound.db` is
physically damaged, so the agent never goes silent for hours again. Companion
to [db-session.md](db-session.md) (schemas) and [db.md](db.md) (cross-mount
rules).

## 1. Why this exists

`outbound.db` is a SQLite file the container writes through a Docker Desktop
bind mount (virtiofs on macOS). Twice in one week the same session's file was
torn — `PRAGMA integrity_check` reported `Freelist: freelist leaf count too
big`, `2nd reference to page`, `wrong # of entries in index` — and the host
kept spawning a container that died at boot:

| | 2026-11-02 | 2026-11-07 |
|---|---|---|
| Session | `ag-1780216909922-7e8236/sess-1780217651807-2io05h` (Telegram group) | same |
| Preceding event | heartbeat ceiling SIGKILL (`Killing container past absolute ceiling`) | none — ordinary writes |
| Symptom | `Container exited non-zero … code=1 … "[agent-runner] Fatal error: database disk image is malformed"` once a minute | same |
| Noticed after | ~5 h | ~minutes (external cron) |
| Fix | manual `sqlite3 .recover` → integrity ok → atomic rename | same |

Both originals are kept next to the live file as
`outbound.db.corrupt-20261103-071319` / `outbound.db.corrupt-20261108-141649`
and double as test fixtures (`src/outbound-recovery.test.ts`).

The host-side self-heal from #94 (`src/outbound-corruption.ts`) didn't fire:
it keys off *host read* errors, and freelist damage leaves `messages_out`
reads working — only the container's `CREATE TABLE IF NOT EXISTS` / `DELETE`
at startup tripped. It would also have recreated an empty file, losing
undelivered replies and the provider continuation in `session_state`.

## 2. Exit codes the agent-runner uses

Defined in `container/agent-runner/src/db/corruption.ts`; the host only ever
sees the exit code and a stderr tail, so the code *is* the diagnosis.

| Code | Meaning | Host reaction |
|---|---|---|
| `1` | Any other fatal error | log `Container exited non-zero`; next wake comes from the sweep |
| `75` | `inbound.db` read view is poisoned (page-cache coherency across the mount, 10 consecutive corruption errors in the follow-up poll). File on the host is fine. | respawn with a fresh mount (sweep), subject to spawn backoff |
| `76` | `outbound.db` — the file this container owns — fails `PRAGMA quick_check` on a fresh connection. The container can't fix its own file. | `handleContainerCorruptionExit` → quick_check on the host → recover (§3) → reset backoff → respawn if work is pending |

Where 76 is raised:

- `getOutboundDb()` open/init throws → wrapped as `OutboundCorruptionError` → `index.ts` `main().catch` exits 76.
- Any other fatal corruption error reaching `main().catch` → `corruptionExitCode()` runs quick_check on `/workspace/outbound.db`: corrupt → 76, otherwise 75.
- The poll loop's follow-up catch runs the same quick_check *before* counting towards the inbound streak, so an outbound write failure mid-turn exits 76 at once instead of ten polls later as 75.

For images predating this code, the host also treats a non-zero exit whose
stderr tail contains `database disk image is malformed` / `SQLITE_CORRUPT` /
`SQLITE_NOTADB` / `file is not a database` as a corruption report. quick_check
on the host guards both paths against a stale in-container view.

## 3. Recovery order (`src/outbound-recovery.ts`)

Precondition: the container is gone (close handler, or `killContainer`'s
`onExit`). Then:

1. `outbound.db` → `outbound.db.corrupt-<stamp>.bak`; `-journal`/`-wal`/`-shm`
   move alongside so nothing is replayed into the new file. **Never deleted.**
2. A journal-free scratch copy of the `.bak` is the read source.
3. Build `outbound.db.recovering-<stamp>`:
   1. **`sqlite3 -readonly <copy> .recover | sqlite3 <new>`** when a `sqlite3`
      CLI is on PATH (macOS ships one). Walks pages directly; survives index
      and freelist damage. Must pass `integrity_check`. `lost_and_found` rows
      are counted, logged and dropped from the live file (they are still in
      the `.bak`).
   2. **Row copy via better-sqlite3** — `ensureSchema` on the new file, then
      per table in priority order `session_state` → `processing_ack` →
      `messages_out` → `container_state`, `SELECT … NOT INDEXED` row by row
      with per-row `try/catch`. A torn page costs only the rows on it.
   3. **Empty schema** (the #94 behaviour) if neither passes `integrity_check`.
4. `ensureSchema` (so tables added after the file was created exist),
   `journal_mode=DELETE`, then `renameSync` onto `outbound.db` — atomic on one
   filesystem.
5. Log `Recovered corrupt outbound DB` with method, per-table
   `recovered/source (-dropped)` counts and the backup path.

Afterwards `outbound-corruption.ts` resets the session's spawn backoff and
wakes the container if `messages_in` has due rows.

Manual equivalent (what the automation does, for an operator with a shell):

```bash
cd data/v2-sessions/<group>/<session>
sqlite3 -readonly outbound.db "PRAGMA integrity_check"
mv outbound.db outbound.db.corrupt-$(date +%Y%m%d-%H%M%S).bak
sqlite3 -readonly outbound.db.corrupt-*.bak .recover | sqlite3 outbound.db.new
sqlite3 outbound.db.new "PRAGMA integrity_check"   # must print ok
mv outbound.db.new outbound.db
```

## 4. Per-session spawn backoff (`src/session-spawn-backoff.ts`)

`src/circuit-breaker.ts` protects the *host process* from its own crash loop.
This is the per-session equivalent, in memory, used by `wakeContainer` (the
single gate — router, delivery, approvals and sweep all go through it) and
read by `host-sweep` for the log line.

- A **strike** is a non-zero exit within 30 s of spawn (`EARLY_EXIT_WINDOW_MS`).
- Hold before the next spawn, by consecutive strikes: `0, 0, 1 min, 5 min,
  15 min` (cap).
- Cleared by: exit 0, host kill (code `null`), an exit after the 30 s window,
  one hour of quiet (`RESET_AFTER_MS`), or an explicit `reset()` — which
  outbound recovery calls because it fixed the cause.
- While held, every sweep tick logs at **error**:
  `Session held by early-exit backoff — not waking despite due messages` with
  `consecutiveFailures`, `lastExitCode`, `resumeAt` and the last five stderr
  lines. That repeating line is the operator signal; the monitoring script
  can grep for `early-exit backoff`.
- On each **escalation** (3rd, 4th, 5th strike) `container-runner` also DMs
  an admin through the approvals module's approver resolution
  (`src/session-crash-alert.ts`: scoped admins → global admins → owners,
  first reachable DM). Best-effort; failures are logged and never block.
  Nothing is sent after the cap, so a session stuck for a day produces three
  DMs, not three hundred.

A host restart forgets all strikes. That's intended: a restart is an operator
acting.

## 5. The bind mount itself (investigation notes, not fixed here)

The 2026-11-07 incident had no kill, so the write path through the mount is
suspect. Facts gathered on the affected Mac:

- Docker Desktop 29.5.2, Linux 6.12 linuxkit, Apple silicon. File sharing
  implementation is the default (no override in
  `~/Library/Group Containers/group.com.docker/settings-store.json`), i.e.
  **virtiofs**. Inside a container the mount shows as the `fakeowner`
  overlay on top of virtiofs:

  ```bash
  docker run --rm -v "$PWD/data:/d:ro" alpine sh -c 'grep " /d " /proc/mounts'
  # /run/host_mark/Users /d fakeowner ro,…,fakeowner 0 0
  python3 -c 'import json;d=json.load(open("'"$HOME"'/Library/Group Containers/group.com.docker/settings-store.json"));print({k:v for k,v in d.items() if "FileSharing" in k or "irtio" in k})'
  # {}  → defaults (virtiofs). A legacy install may show gRPC FUSE / osxfs.
  ```

- `PRAGMA synchronous` is already `FULL` (2) under both bun:sqlite 1.3 and
  better-sqlite3 in rollback-journal mode (compile default
  `DEFAULT_SYNCHRONOUS=2`). `getOutboundDb()` now pins it explicitly so a
  runtime upgrade can't quietly weaken it. Whether virtiofs honours the
  resulting `fsync` ordering is the open question; SQLite's own guidance is
  that network/VM filesystems with unreliable locking or fsync are outside
  its durability guarantees.
- The MCP-tools process (`send_message` etc.) is a second writer of
  `outbound.db` inside the same container. Both writers share one guest
  kernel so POSIX locking works between them; not a suspect, but worth
  knowing when reading the schema's "one writer per file" rule.
- `journal_mode=WAL` is **not** an option: the `-shm` mmap isn't coherent
  across virtiofs and `inbound.db` readers freeze (see `session-manager.ts`).

Larger design option, for a separate change: move the container→host channel
off SQLite altogether — an append-only JSONL `messages_out.log` plus a tiny
`session_state.json`, both written with write-to-temp + rename. Appends and
renames are the two operations every VM file-sharing layer gets right; there
is no freelist to corrupt and a torn tail costs one line, not the file. The
host would tail the log and keep its delivered-set in `inbound.db` as today.
`processing_ack` could live in the same log as status lines. It changes the
agent-runner, delivery, host-sweep and `ncl`'s session transport, so it needs
its own design pass.

## 6. Upstream (nanocoai/nanoclaw) status, as of 2026-11-14

Checked against `upstream/main` (`bd55d0eb`, ~1,100 commits ahead of this
fork, with the session DBs behind a "mailbox" seam):

- The agent-runner has `SqliteAgentMailbox.shouldRestartAfter()` (same
  corruption matcher) and exits **75** after a streak — the inbound case
  only; there is no outbound-specific code or quick_check.
- `readInbound()` retries torn mid-write reads for 1 s (#4118) — the
  inbound side of the same mount problem.
- **No** host-side quarantine or `.recover` of `outbound.db`, **no**
  per-session spawn backoff (only the host-level circuit breaker), **no**
  `synchronous` pinning.

So nothing here is superseded by upstream. When this fork next syncs
(`/deshi-update-from-upstream`), the pieces map to: exit codes →
`container/agent-runner/src/mailbox/sqlite/`; host recovery → the host
mailbox driver (`src/mailbox/sqlite/`); backoff → `src/container-runner.ts`
/ `src/reconcile-session.ts`.

## 7. Operating it

- **Detect**: `grep -c 'Fatal error: database disk image is malformed' logs/nanoclaw.error.log`
  should stop growing within a minute of the first hit; look for
  `Outbound DB corruption confirmed by container exit — recovering` and
  `Recovered corrupt outbound DB` next. `early-exit backoff` lines mean the
  session is dying at boot for a reason recovery didn't fix (read the
  `lastStderrTail`).
- **External check** (boswell side): `bash ~/code/boswell/daemon/deploy/nanoclaw-db-check.sh`
  runs `quick_check` on every session DB and reports loops; `--repair` does
  the same `.recover` by hand.
- **Backups**: `ls data/v2-sessions/*/*/outbound.db.corrupt-*` — safe to
  archive elsewhere once you're sure nothing needs salvaging; the automation
  never deletes them.
