# `supabase functions serve`

## Files Read

| Path                                                                | Format     | When                                                                                                              |
| ------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`                                    | TOML       | On every startup and watch restart.                                                                               |
| Project dotenv files and `<workdir>/supabase/functions/.env`        | dotenv     | On every startup and watch restart; the explicit `--env-file` takes precedence.                                   |
| `<workdir>/supabase/functions/<function-name>/.env`                 | dotenv     | On every startup and watch restart when `--env-file` is unset; values override the shared file for that Function. |
| `<env-file>`                                                        | dotenv     | When `--env-file` is set; relative paths resolve from the caller cwd.                                             |
| `<workdir>/supabase/functions/*/index.ts`                           | TypeScript | To discover filesystem-backed Functions.                                                                          |
| Config-declared entrypoints, import maps, static files, and imports | mixed      | To build the effective service configuration and watch roots.                                                     |

## Files Written

| Path                         | Format            | When                                                                                         |
| ---------------------------- | ----------------- | -------------------------------------------------------------------------------------------- |
| `~/.supabase/telemetry.json` | JSON              | At command exit through `Effect.ensuring`.                                                   |
| Managed stack service state  | typed stack state | The stack owner persists service configuration, intent, endpoint plans, and operation state. |

Secret values stay redacted in the service configuration and are materialized only by the stack
owner during runtime startup.

## API Routes

The CLI opens or creates the project stack through `StackApi`, resolves the registered `functions`
service, and observes that service's logs and status. The service uses the shared stack gateway for
its routes. Functions can start while PostgreSQL, Auth, and REST are disabled or absent.

## Environment Variables

| Variable                              | Purpose                                                                       | Required? |
| ------------------------------------- | ----------------------------------------------------------------------------- | --------- |
| `SUPABASE_PROFILE`                    | Resolves the profile and API base URL.                                        | no        |
| `SUPABASE_WORKDIR`                    | Overrides the project workdir.                                                | no        |
| `SUPABASE_PROJECT_ID`                 | Config-service override for project identity.                                 | no        |
| `SUPABASE_ENV`                        | Selects environment-specific dotenv files.                                    | no        |
| Variables referenced by `config.toml` | Config interpolation; ambient values are layered under project dotenv values. | no        |
| `SUPABASE_NETWORK_ID`                 | Retained for project environment compatibility.                               | no        |
| `BITBUCKET_CLONE_DIR`                 | Retained for project environment compatibility.                               | no        |

## Exit Codes

| Code | Condition                                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | Clean shutdown after `SIGINT` or `SIGTERM`.                                                                                              |
| `0`  | The managed Functions service exits normally or is retired by another stack owner.                                                       |
| `1`  | Invalid inspect flags, config, environment file, import map, Function input, service preparation, startup, log stream, or watch restart. |

## Telemetry Events Fired

| Event                  | When                                                       | Notable properties / groups         |
| ---------------------- | ---------------------------------------------------------- | ----------------------------------- |
| `cli_command_executed` | Post-run, success or failure, through the command wrapper. | `exit_code`, `duration_ms`, `flags` |

## Output

`--output-format text` writes lifecycle text to the established streams:

- `Setting up Edge Functions runtime...` before startup.
- `Skipped serving Function: <slug>` for disabled Functions.
- `File change detected: <path> (<op>)` when a watched file triggers a restart.
- Live logs attributed to the registered Functions service.
- `Stopped serving supabase/functions` on a user-initiated shutdown.
- `Edge Runtime exited ...` when the service exits on its own.

Machine-readable modes carry the service log and error stream; there is no final success payload.

## Notes

- Legacy Function name positional arguments are accepted and ignored. The command serves every discovered Function.
- `--all` remains parsed but hidden; all discovered and config-declared Functions, including disabled entries, are preserved in the candidate configuration.
- Every startup resolves flags, dotenv precedence, entrypoints, import maps, static files, reserved environment names, inspector mode, and debugger wallclock behavior into one effective Functions service configuration.
- The command compares a non-mutating stack preparation fingerprint with the registered service descriptor. An unchanged compatible service is joined; a changed configuration explicitly restarts the same instance ID.
- A watched source change re-resolves all inputs, restarts the same registered instance with the full candidate configuration, and rebuilds watcher roots. Import-map scope targets outside the project are warned once and excluded from watch roots; redundant mounts are pruned while covering mounts remain visible.
- The command closes log and watch subscriptions on exit. It does not stop, sleep, destroy, or restore the service when the CLI client exits.
