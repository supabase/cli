# `supabase experimental stack restart`

## Files Read

Reads the selected stack's descriptor and `<SUPABASE_HOME>/managed/stacks/<id>/state.json`,
plus owner metadata in `control.json` when present. Configuration comes from the
selected descriptor's project root: `supabase/config.toml` or `supabase/config.json`,
project environment input through the config loader, configured signing material,
and enabled function dotenv files under `supabase/functions/`.

## Files Written

The CLI does not rewrite project configuration. The stack package updates its
state record, owner metadata, runtime files, logs, and service data beneath the
selected stack directory. Preparation may populate the package's artifact cache
or the container engine's image store. Restart preserves the stack ID and data;
it never calls create or destroy.

## API Routes

No Management API routes. The command uses local stack control RPC and delegates
artifact downloads, container operations, and service startup to the package.
Artifact URLs and registry requests depend on the selected runtime and releases.

## Environment Variables

- `SUPABASE_HOME`: managed state location; defaults to the user's `.supabase` directory.
- `HOME`: participates in default home resolution.
- Environment references in project configuration and function dotenv files are
  resolved by the shared config loader. Their secret values are not emitted.
- Standard CLI settings, output, and telemetry environment controls apply through
  the existing CLI layers; restart adds no command-specific environment variables.

## Exit Codes

| Code  | Condition                                                                                            |
| ----- | ---------------------------------------------------------------------------------------------------- |
| `0`   | The selected stack restarted successfully.                                                           |
| `1`   | Invalid flags, missing stack/configuration, or a configuration, preparation, stop, or start failure. |
| `130` | The CLI waiter was interrupted.                                                                      |

## Telemetry Events Fired

Standard command instrumentation emits `cli_command_executed` for success or
failure, with duration, sanitized flags, and error classification. Restart adds
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
project. Configuration validation and preparation precede stop. A preparation
failure leaves the running stack untouched; stop failure prevents start; start
failure leaves the same stack stopped and available for recovery. Interrupting
the CLI waiter follows the package's owner lifecycle contract and does not invoke
destroy from the command handler.
