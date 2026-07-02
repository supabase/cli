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

Go's `stop` has **no** `-o`/`--output` flag at all, so the Go-compat `LegacyOutputFlag`
is not consulted by this handler — only the TS-native `--output-format` matters here.
This is a harmless, documented divergence: Go would reject an unknown `-o` flag outright.

### `--output-format text` (Go CLI compatible)

- stderr (transient): `Stopping containers...`
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
- Volume prune always passes `--all`. Go gates that flag on Docker engine >= 1.42
  (`docker.go:120-124`, since named-volume pruning requires it); the TS port skips the
  version check and always passes `--all` because every currently supported Docker
  version is far past 1.42.
- Containers are stopped concurrently (`Effect.all(..., { concurrency: "unbounded" })`),
  mirroring Go's `WaitAll` goroutine fan-out. Every container's failure is checked before
  failing the command (rather than stopping at the first failure), matching Go's
  `errors.Join` over the full result set — though the surfaced message is a single fixed
  string rather than a joined list of per-container errors, since Docker CLI subprocess
  stderr isn't captured per-container the way Go's SDK error is.
- No e2e test is planned: there is no Docker-daemon-free golden path for this command,
  and the e2e harness (`runSupabase()`) does not provision a real local stack. See the
  CLI-1324 plan's "E2e tests" section for the full justification.
