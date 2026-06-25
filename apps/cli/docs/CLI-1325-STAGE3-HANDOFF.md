# CLI-1325 — Stage 3 Handoff (`db start` + `db reset --local`)

> **Purpose**: hand off the remaining work on CLI-1325 ("Port `supabase db reset` /
> `supabase db push` / `supabase db start`") to a local agent that has Docker and
> can build the Go binary. Stages 1–2 are done and on this branch
> (`claude/gifted-knuth-mslxnh`). Stage 3 is the container-bootstrap work that
> could not be validated in the cloud environment.

---

## 1. Context

- **Repo**: `supabase/cli`. Branch: `claude/gifted-knuth-mslxnh`.
- **What this is**: a strict **1:1 port** of the Go CLI into the TypeScript
  **legacy shell** at `apps/cli/src/legacy/`. The authoritative reference is the
  vendored Go source at `apps/cli-go/`. Match Go's stdout/stderr text, flags,
  filesystem effects, API routes, and exit codes **exactly**.
- **Read first**: `apps/cli/CLAUDE.md` (the legacy-port playbook — naming, telemetry
  parity, `--output-format`, SIDE_EFFECTS, testing rules) and the repo-root
  `CLAUDE.md`.
- **Chosen architecture for Stage 3** (decided with the issue owner): a **hidden Go
  seam**. Native TS orchestrates; container provisioning that isn't ported stays in
  Go behind a hidden `__db-bootstrap` command, mirroring the existing `__shadow`
  seam at `apps/cli-go/cmd/db.go:219`. The TS side shells out to it via
  `LegacyGoProxy`.

---

## 2. What is already done (Stages 1–2, on this branch)

| Command    | Status                                                                    | Where                                    |
| ---------- | ------------------------------------------------------------------------- | ---------------------------------------- |
| `db push`  | **ported** (fully native)                                                 | `apps/cli/src/legacy/commands/db/push/`  |
| `db reset` | **partial** — remote path native; local + `--experimental` delegate to Go | `apps/cli/src/legacy/commands/db/reset/` |
| `db start` | **wrapped** (Go proxy, untouched)                                         | `apps/cli/src/legacy/commands/db/start/` |

Commits (newest first): `docs(cli): document db reset…`, `feat(cli): implement
native db reset remote path`, `docs(cli): document db push…`, `test(cli): expand db
push coverage…`, `test(cli): integration tests for native db push`, `feat(cli):
implement native db push handler`, `feat(cli): add vault upsert…`, `feat(cli): add
seed-file ops…`, `feat(cli): add pending-migration reconciliation…`.

### Reusable shared helpers already built (use these — do not re-implement)

All under `apps/cli/src/legacy/`:

- `commands/db/shared/legacy-migration-pending.ts` — `legacyFindPendingMigrations`,
  `legacyIncludeAllPending`, `legacySuggestRevertHistory`, `legacySuggestIgnoreFlag`.
- `commands/db/shared/legacy-seed-ops.ts` — `legacyGetPendingSeeds`,
  `legacySeedData`, `LegacySeedFile`, `legacyMatchPattern` (Go `fs.Glob`/`path.Match`
  port). Seed paths resolve under `supabase/` and dedupe like Go's `config.Glob.Files`.
- `commands/db/shared/legacy-vault.ts` — `legacyUpsertVaultSecrets`,
  `legacyReadVaultDocument`, `legacySyncableVaultSecrets`. **Gap**: `encrypted:`
  vault secrets are skipped (ECIES/dotenvx decryption not ported).
- `commands/db/shared/legacy-drop-schemas.ts` — `legacyDropUserSchemas` (embedded
  `drop.sql` `DO` block).
- `shared/legacy-migration-apply.ts` — `legacyApplyMigrations` (emits
  `Applying migration <file>...`), `legacySeedGlobals`, `legacyApplyMigrationFile`.
- `commands/db/shared/legacy-pgdelta.cache.ts` — `legacyListLocalMigrations`
  (Go-faithful local migration listing, with the deprecated-init skip).

### Existing Docker / container infra in the legacy shell (for Stage 3)

- `shared/legacy-docker-run.service.ts` + `.layer.ts` — `LegacyDockerRun`
  (`run`/`runCapture`/`runStream`).
- `shared/legacy-container-cli.ts` — `LegacyContainerCli`.
- `shared/legacy-docker-registry.ts` — `LegacyDockerRegistry`.
- `shared/legacy/go-proxy.service.ts` — `LegacyGoProxy` (`exec`, `execCapture`),
  **ambient** (provided at root in `legacy/cli/root.ts`).

### Patterns established in Stages 1–2 (copy these)

- Command file wires `withLegacyCommandInstrumentation({ flags, safeFlags? })` +
  `withJsonErrorHandling` + `Command.provide(<runtime layer>)`.
- Runtime layers mirror `commands/db/push/push.layers.ts` (and `lint.layers.ts`):
  lazy `legacyPlatformApiFactoryLayer` so `--local`/`--db-url` never resolve a token
  at layer-build time; single shared `legacyIdentityStitchLayer`.
- Handler body wrapped in `.pipe(Effect.ensuring(linkedProjectCache.cache(ref)),
Effect.ensuring(telemetryState.flush))`.
- **Delegating to Go without double-counting telemetry**: call
  `proxy.exec(args, { env: { SUPABASE_TELEMETRY_DISABLED: "1" } })`. The TS
  instrumentation wrapper then fires `cli_command_executed` exactly once. This is
  how `db reset`'s local/experimental paths already work
  (`reset.handler.ts:147,154`).

---

## 3. Stage 3 scope

Make `db start` native, and replace `db reset --local`'s Go delegation
(`reset.handler.ts:146-149`) with a native local reset. Both lean on a new hidden
Go seam for the parts that aren't ported (container create/recreate, init schema,
service restarts).

### 3a. Go behavior to match — `db start` (`apps/cli-go/internal/db/start/start.go`)

Entry: `cmd/db.go:337` → `start.Run(ctx, fromBackup, fsys)`. Flag: `--from-backup`
(string, `cmd/db.go:590`). `Run` (lines 44-61):

1. `flags.LoadConfig(fsys)`.
2. `AssertSupabaseDbIsRunning()`: if already running → `fmt.Fprintln(os.Stderr,
"Postgres database is already running.")` and **return nil** (exit 0). If the
   error is anything other than `utils.ErrNotRunning`, return it.
3. `StartDatabase(ctx, fromBackup, fsys, os.Stderr)`; on error,
   `utils.DockerRemoveAll(...)` cleanup then return the error.

`StartDatabase` (lines 133-190): builds container/host/network config
(`NewContainerConfig`/`NewHostConfig`), handles `--from-backup` (restore entrypoint

- bind mount `/etc/backup.sql:ro`), inspects the db volume to set
  `utils.NoBackupVolume`, then:

* `NoBackupVolume` → `Starting database...`; else if `--from-backup` →
  `Starting database from backup...` (lines 168-174; both to the writer `w` =
  stderr).
* `WaitForHealthyService(ctx, Config.Db.HealthTimeout, utils.DbId)` — health check
  **skipped** when `--from-backup` is set (line 180).
* If `NoBackupVolume && no --from-backup` → `SetupLocalDatabase(ctx, "", fsys, w)`
  (line 185), which prints `Initialising schema...` (line 244) and applies initial
  schema + roles + migrations + seed.
* `initCurrentBranch(fsys)` (line 189) — writes the `_current_branch` file.

**Important parity facts**: `db start` does **NOT** print the full status table and
does **NOT** fire `cli_stack_started` — those belong to the top-level `supabase
start` (`internal/start/start.go`), not `db start`. No `Finished` line.

### 3b. Go behavior to match — `db reset` local (`apps/cli-go/internal/db/reset/reset.go`)

The local path is reached when `utils.IsLocalDatabase(config)` is true (Go
`reset.go:53`). In the TS handler this is the `cfg.isLocal` branch currently
delegating to Go (`reset.handler.ts:146`). Version/`--last` resolution
(`reset.go:34-52`) is **already ported** and runs before the split — reuse it.

Local flow (`reset.go:57-77`):

1. `AssertSupabaseDbIsRunning()` — error if the db container isn't up.
2. `resetDatabase(ctx, version, fsys)` → `Resetting local database<toLogMessage>`
   (line 81), then branch on `Config.Db.MajorVersion`:
   - **≤ 14** → `resetDatabase14` (line 95): `recreateDatabase` (drop/recreate
     `postgres` + `_supabase` dbs), `initDatabase`, `RestartDatabase`
     (`Restarting containers...`), connect, `apply.MigrateAndSeed(ctx, version,
conn, fsys)`.
   - **≥ 15** → `resetDatabase15` (line 113): `Docker.ContainerRemove(DbId, Force)`,
     `Docker.VolumeRemove(DbId, force)`, `Recreating database...` (line 129),
     recreate container via `DockerStart(NewContainerConfig()/NewHostConfig())`,
     wait healthy, `start.SetupLocalDatabase(ctx, version, fsys)`,
     `Restarting containers...` (line 139), `restartServices(ctx)` (line 140).
3. If the storage container is healthy → `buckets.Run(ctx, "", false, fsys)` to seed
   `supabase/buckets/` (reset.go:65-74). The **legacy `seed buckets` command is
   already ported** (`commands/seed/buckets/`) — reuse `legacySeedBuckets`/its core.
4. `branch := utils.GetGitBranch(fsys)`; `Finished supabase db reset on branch
<branch>.` to stderr (line 76; `supabase db reset` and `<branch>` are Aqua).

`restartServices` (reset.go:226-240) restarts `[StorageId, GotrueId, RealtimeId,
PoolerId]`. `apply.MigrateAndSeed` is the same routine `db reset` remote uses — the
TS equivalent (drop is NOT done locally; instead the db is recreated) is
`legacyApplyMigrations` (partial migrations) + `legacyGetPendingSeeds` +
`legacySeedData`, already wired in `reset.handler.ts` for the remote path. Factor
that "migrate + seed against a connected session" block into a shared helper so both
the remote and local paths call it.

### 3c. The hidden `__db-bootstrap` Go seam

Mirror `__shadow` (`apps/cli-go/cmd/db.go:219-268`). Add a hidden command that
exposes the un-ported container primitives so the TS side can invoke them and then
do the SQL orchestration itself (connect, migrate, seed, restart). Suggested
sub-operations (drive via a `--mode` flag like `__shadow`):

- `start` → `start.StartDatabase(fromBackup)` (create + health + `SetupLocalDatabase`
  - `initCurrentBranch`).
- `recreate` → `reset.resetDatabase15` container remove/volume-remove/recreate +
  `SetupLocalDatabase(version)` (the PG15 path), or `resetDatabase14` for PG≤14.
- `restart-services` → `reset.restartServices`.
- An "is running" probe so the TS side can replicate `AssertSupabaseDbIsRunning`
  without porting Docker inspect (or use `LegacyDockerRun`/`LegacyContainerCli`).

Decide how much SQL stays native vs behind the seam. The thinnest correct split:
the seam does **only** container lifecycle + `SetupLocalDatabase` (initial schema /
roles / first migrate+seed), and the TS side does the "already running?" check,
user-facing messages, the bucket seeding (reuse `legacySeedBuckets`), the
git-branch `Finished …` line, and `--output-format` shaping. Keep the seam's stdout
machine-parseable (newline-separated, no secrets) like `__shadow`.

When you add the seam: update the three `__shadow`-style steps in `cmd/db.go`,
rebuild the bundled Go binary (`apps/cli/scripts` / `pnpm --filter @supabase/cli
build:go-sidecar` — check `apps/cli/package.json` scripts), and confirm
`LegacyGoProxy` can reach it.

---

## 4. Deliverables checklist (Stage 3)

- [ ] `db start` native handler + `start.layers.ts` + `start.errors.ts`; replace the
      proxy in `commands/db/start/`. Match every string in §3a. No `cli_stack_started`.
- [ ] `db reset` local path native in `reset.handler.ts` (replace the `cfg.isLocal`
      Go delegation); reuse the shared migrate+seed block and `legacySeedBuckets`.
- [ ] Hidden `__db-bootstrap` Go command in `apps/cli-go/cmd/db.go`; rebuild the
      bundled binary.
- [ ] Shared helper for "migrate + seed against a connected session" (extract from
      the remote reset path so local + remote share it).
- [ ] `commands/db/start/SIDE_EFFECTS.md` (rewrite from proxy stub) and update
      `commands/db/reset/SIDE_EFFECTS.md` for the now-native local path.
- [ ] Integration tests (handler, ~100% branch — see precedent: one unreachable
      defensive guard is acceptable, as in push/reset). Mock `LegacyDockerRun` /
      the seam / `LegacyDbConnection`.
- [ ] **E2E** (`*.e2e.test.ts`) golden paths via `tests/helpers/cli.ts` `runSupabase`
      against a **real local stack** — this is the part requiring Docker. Cover
      `db start` (fresh + already-running) and `db reset` local.
- [ ] Flip `db start` → `ported` and `db reset` → `ported` in
      `apps/cli/docs/go-cli-porting-status.md` (two tables: the leaf table ~line 89-91
      and the status table ~line 303-307).
- [ ] Telemetry: confirm no custom events for `db start`/`db reset` (none in Go);
      keep `withLegacyCommandInstrumentation`.

---

## 5. How to build / test / verify in this repo

`nx` is **not** on PATH; invoke tools directly from `apps/cli/`:

```sh
# from repo root, once:
pnpm install            # (and `pnpm repos:install` if .repos/effect is missing)

# from apps/cli/ :
# typecheck (tsgo, the repo's TS checker):
./node_modules/.bin/tsgo --noEmit -p tsconfig.json

# tests MUST run under the Bun runtime (they import @effect/platform-bun):
bun --bun ./node_modules/vitest/vitest.mjs run --project unit <file>
bun --bun ./node_modules/vitest/vitest.mjs run --project integration <file>
# coverage (istanbul) for a handler — aim ~100% branch:
bun --bun ./node_modules/vitest/vitest.mjs run --project integration \
  --coverage --coverage.reporter=json --coverage.reportsDirectory=/tmp/cov \
  --coverage.include='src/legacy/commands/db/start/start.handler.ts' <test-file>

# e2e (needs Docker; do not run the full suite — target the file):
bun --bun ./node_modules/vitest/vitest.mjs run --project e2e <file>.e2e.test.ts

# lint / format / unused-exports:
./node_modules/.bin/oxfmt <files>        # writes; add --check to verify
./node_modules/.bin/oxlint <files>
./node_modules/.bin/knip                 # de-export internal-only helpers it flags
```

The canonical full gate (CLAUDE.md): `bun run test` + `bun run --parallel "*:check"`
(these go through `nx`; if `nx` is unavailable, run the direct commands above).

---

## 6. Gotchas / parity rules learned in Stages 1–2

- **Bun runtime for tests**: plain `pnpm vitest` fails (`Cannot find package 'bun'`);
  always `bun --bun ./node_modules/vitest/vitest.mjs`.
- **Telemetry double-count**: any Go delegation must pass
  `env: { SUPABASE_TELEMETRY_DISABLED: "1" }` so the child doesn't also emit
  `cli_command_executed`.
- **stdout vs stderr**: progress/diagnostics → stderr; the only stdout text Go emits
  for these commands is suppressed in `json`/`stream-json` mode (emit a structured
  `output.success(...)` instead). See CLI-1546 notes in `apps/cli/CLAUDE.md`.
- **Colors**: match Go's `utils.Aqua` (cyan) / `utils.Bold` via `legacy-colors.ts`
  (`legacyAqua`, `legacyBold`). Tests assert with `toContain` to tolerate ANSI.
- **`db start` connects via `io.Discard` in `db reset` remote** — note `db start`
  itself writes progress to stderr; double-check each `Fprintln(w, …)` target.
- **Coverage**: handler integration tests target 100% branch; a single genuinely
  unreachable defensive guard is acceptable (push and reset each have one).
  Relocate defensive parsing into unit-tested pure helpers where practical (see how
  `legacyReadVaultDocument` was moved into `legacy-vault.ts`).
- **Config access**: use `loadProjectConfig(workdir, { projectRef? })` from
  `@supabase/config`; `config.db.{migrations.enabled, seed.enabled, seed.sql_paths}`;
  raw `[db.vault]` via the returned `document`. `MajorVersion` is at
  `config.db.major_version` — needed for the PG14 vs PG15 reset branch.
- **`--no-seed`**: forces seed disabled (Go sets `Config.Db.Seed.Enabled = false`).

---

## 7. Key Go reference files (read these on the local machine)

- `apps/cli-go/cmd/db.go` — flag defs + `__shadow` seam to mirror (lines ~219-268,
  337-343, 567-591).
- `apps/cli-go/internal/db/start/start.go` — `Run`, `StartDatabase`,
  `SetupLocalDatabase`, `WaitForHealthyService`, `initCurrentBranch`,
  `NewContainerConfig`/`NewHostConfig`.
- `apps/cli-go/internal/db/reset/reset.go` — local `resetDatabase14`/`15`,
  `recreateDatabase`, `initDatabase`, `RestartDatabase`, `restartServices`,
  `toLogMessage`.
- `apps/cli-go/internal/migration/apply/apply.go` — `MigrateAndSeed` (already
  mirrored in the TS remote reset path).
- `apps/cli-go/internal/seed/buckets/buckets.go` — bucket seeding invoked by local
  reset (TS port exists at `commands/seed/buckets/`).
