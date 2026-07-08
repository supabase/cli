# `supabase stop`

Native TypeScript port of Go's `internal/stop`. Talks directly to Docker via subprocess
(`docker`/`podman`), replicating Go's label-filtering and container-naming scheme
byte-for-byte — it does not go through `@supabase/stack/effect`'s orchestration model
(see the CLI-1324 plan's "Critical architectural finding" for why).

## Files Read

| Path                             | Format | When                                                                       |
| -------------------------------- | ------ | -------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml` | TOML   | default path only — skipped entirely when `--project-id` or `--all` is set |

## Files Written

| Path                         | Format | When                                                        |
| ---------------------------- | ------ | ----------------------------------------------------------- |
| `~/.supabase/telemetry.json` | JSON   | always (in `Effect.ensuring`) at end of command — Go parity |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

Neither `stop` nor its Go counterpart make any Management API call. Everything is local
Docker + local `config.toml`.

## Environment Variables

| Variable              | Purpose                                                                                            | Required?                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `SUPABASE_PROJECT_ID` | overrides the resolved local project id on the default path (env → config.toml → workdir basename) | no                                                                |
| `SUPABASE_WORKDIR`    | resolves `LegacyCliConfig.workdir`, which locates `config.toml` on the default path                | no (falls back to walking up from cwd for `supabase/config.toml`) |

`docker`/`podman` must be resolvable on `PATH` (or reachable via the configured Docker
context) — `spawnContainerCli` tries `docker` first and falls back to `podman`. When
neither can be spawned at all, the error message names the actual root cause (e.g.
"docker: command not found (podman also not found) — install Docker Desktop or Podman
and ensure it is on PATH") rather than a generic "failed to ..." string.

## Exit Codes

| Code | Condition                                                                                                |
| ---- | -------------------------------------------------------------------------------------------------------- |
| `0`  | success — containers/volumes/networks pruned                                                             |
| `1`  | `--project-id` and `--all` both set (`LegacyStopMutuallyExclusiveError`)                                 |
| `1`  | `config.toml` present but malformed (`LegacyStopConfigLoadError`) — an **absent** file is not an error   |
| `1`  | listing containers failed (`LegacyStopListError`)                                                        |
| `1`  | stopping one or more containers failed (`LegacyStopContainerError`)                                      |
| `1`  | `docker container prune` failed (`LegacyStopContainerPruneError`)                                        |
| `1`  | `docker volume prune` failed, only reached when volumes are being deleted (`LegacyStopVolumePruneError`) |
| `1`  | `docker network prune` failed (`LegacyStopNetworkPruneError`)                                            |
| `1`  | `docker`/`podman` both absent from `PATH` (surfaces as one of the errors above)                          |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

Matches `apps/cli-go/internal/stop/`. Go does not fire any custom telemetry event for
this command.

## Output

Go's `stop.RunE` never reads `-o`/`--output` itself, but the flag is still registered
on the root command as a `PersistentFlags()` enum (`cmd/root.go:330`,
`env|pretty|json|toml|yaml`) that every subcommand inherits, so `stop -o csv`/`-o table`
is rejected by pflag at parse time, before `RunE` runs — Go never reaches this command's
body with an unsupported value. `stop.command.ts` matches this: it wraps the handler
with `withLegacyCommandInstrumentation`, whose default `outputFormats`
(`LEGACY_RESOURCE_OUTPUT_FORMATS`, same `env|pretty|json|toml|yaml` set) validates and
rejects the flag before the handler runs — not a divergence, just enforced one layer up
rather than read inside this handler. Only the TS-native `--output-format` is consulted
by this handler's own logic below.

### `--output-format text` (Go CLI compatible)

- stdout: `Stopping containers...` (printed unconditionally before any Docker call,
  matching Go's `fmt.Fprintln` — see `docker.go:97`)
- stdout: `Stopped supabase local development setup.` (`supabase` rendered in Aqua/cyan
  when the output stream is a TTY, plain otherwise)
- stderr (conditional): when any Docker volume still carries the project's
  `com.supabase.cli.project` label after stopping, an additional suggestion line:
  - with a project id filter: `Local data are backed up to docker volume. Use docker to show them: docker volume ls --filter label=com.supabase.cli.project=<id>`
  - with `--all` (empty filter): `Local data are backed up to docker volume. Use docker to show them: docker volume ls --filter label=com.supabase.cli.project`

### `--output-format json`

Additive — no Go CLI equivalent. Single JSON object via `Output.success`:

```json
{ "project_id_filter": "demo", "backup": true }
```

### `--output-format stream-json`

Same payload as `json`, delivered as a `result` NDJSON event.

## Notes

- `--project-id` and `--all` are **directory-independent** pure Docker-label filters —
  neither reads `config.toml`. Only the no-flags default path resolves the project id
  from `LegacyCliConfig.workdir` (env → config.toml `project_id` → workdir basename).
- The hidden `--backup` flag exists only for Go CLI surface parity — it has **no effect**.
  Go declares it via `flags.Bool("backup", true, ...)` (`cmd/stop.go:26`) but never binds
  the return value to a variable, so `RunE` always passes `!noBackup` to `stop.Run`
  regardless of `--backup`. The TS port matches this exactly: `deleteVolumes =
flags.noBackup`. `--backup=false` alone does **not** delete volumes; only
  `--no-backup` does.
- Volume prune gates `--all` on the Docker daemon's API version (`legacy-container-cli.ts`'s
  `legacyDockerSupportsVolumePruneAllFlag`, checked via `docker version --format
'{{.Server.APIVersion}}'`), matching Go's `Docker.ClientVersion() >= "1.42"` check
  (`docker.go:126-133`) exactly. This isn't cosmetic: Docker CLI's own `--all` flag on
  `volume prune` is annotated `version: "1.42"` and enforced by Cobra's `Args` validator
  _before_ pruning runs, so sending it unconditionally on a pre-1.42 daemon hard-fails the
  whole call instead of just pruning a narrower set. On the Podman fallback, `--all` is
  omitted unconditionally instead: no released Podman `volume prune` (checked v4.3 through
  the current v5.7) accepts that flag, and Podman already prunes every unused volume by
  default, so dropping it there is lossless. Podman itself is a TS-only fallback (Go never
  shells out to a `docker`/`podman` binary), so this has no Go-parity implication either way.
- Containers are stopped concurrently (`Effect.all(..., { concurrency: "unbounded" })`),
  mirroring Go's `WaitAll` goroutine fan-out. Every container's failure is checked before
  failing the command (rather than stopping at the first failure), matching Go's
  `errors.Join` over the full result set — though the surfaced message is a single fixed
  string rather than a joined list of per-container errors, since Docker CLI subprocess
  stderr isn't captured per-container the way Go's SDK error is.
- No e2e test is planned: there is no Docker-daemon-free golden path for this command,
  and the e2e harness (`runSupabase()`) does not provision a real local stack. See the
  CLI-1324 plan's "E2e tests" section for the full justification.
