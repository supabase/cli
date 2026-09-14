# `supabase stack restart`

The command is available only when `experimental.stack` is enabled through project
configuration or `SUPABASE_EXPERIMENTAL_STACK=1`. It has no top-level alias.

## Files Read

Reads the selected stack's descriptor and `<SUPABASE_HOME>/managed/stacks/<id>/state.json`,
plus owner metadata in `control.json` when present. Restart does not load project
configuration; it uses the selected stack's saved effective configuration and preparation policy.
Feature routing and workdir discovery may still read `supabase/config.toml` or
`supabase/config.json`. Use `SUPABASE_EXPERIMENTAL_STACK=1` with `--stack-id` when
project configuration is invalid or unavailable. Runtime startup can read files
referenced by the saved definition, such as signing material.

## Files Written

The CLI does not rewrite project configuration. The stack package updates its
state record, owner metadata, runtime files, logs, and service data beneath the
selected stack directory. Restart preserves the stack ID and data; it never calls
create or destroy. There is no explicit `prepare()` call. Runtime startup reuses
cached artifacts and may fetch missing ones; the saved `background` preparation
policy can also prefetch enabled lazy services, while `on-demand` skips that prefetch.

## API Routes

No Management API routes. The command uses local stack control RPC and delegates
artifact downloads, container operations, and service startup to the package.
Artifact URLs and registry requests depend on the selected runtime and releases.

## Environment Variables

- `SUPABASE_HOME`: managed state location; defaults to the user's `.supabase` directory.
- `HOME`: participates in default home resolution.
- Project configuration and function dotenv overrides are not reloaded by the
  restart handler. Saved secret values are not emitted.
- Standard CLI settings, output, and telemetry environment controls apply through
  the existing CLI layers; restart adds no command-specific environment variables.

## Exit Codes

| Code  | Condition                                                 |
| ----- | --------------------------------------------------------- |
| `0`   | The selected stack restarted successfully.                |
| `1`   | Invalid flags, missing stack, or a stop or start failure. |
| `130` | The CLI waiter was interrupted.                           |

## Telemetry Events Fired

Telemetry state is flushed to `<SUPABASE_HOME or ~/.supabase>/telemetry.json`
after successful and failed runs. Standard command instrumentation emits `cli_command_executed` for success or
failure, with canonical command identity `stack restart`, duration, sanitized flags, and error classification. Restart adds
no custom telemetry event and does not emit configuration or credential values.

## Output

- `--output-format text`: stack ID, runtime, lifecycle, configured endpoints, and
  dormant capabilities. Progress is cleared after success or failed before propagation.
- `--output-format json`: one status object containing `id`, `lifecycle`,
  `desired_lifecycle`, `runtime`, `endpoints`, `versions`, `capabilities`, and `artifacts`.
- `--output-format stream-json`: standard progress events, followed by a `result`
  event carrying the same status object, or an `error` event on failure.

Legacy `-o/--output` is rejected with guidance to use `--output-format`.

## Notes

Targets one existing stack through `--stack`, `--stack-id`, or the current
project. The command stops and starts without an explicit configuration. Stop failure prevents
start; start failure leaves the same stack stopped and available for recovery. Interrupting
the CLI waiter follows the package's owner lifecycle contract and does not invoke
destroy from the command handler.
An unconfigured stack must be initialized with `supabase stack start` before it can be restarted.

Restart reuses saved one-off `start` flags such as `--exclude`, `--eager`, and
`--preparation`; a normal `start` reloads project configuration and current flags.
