# `supabase stack prepare`

The command is available only when the `experimental.stack` family is enabled. It resolves the
selected project and stack, loads the effective project configuration, and delegates immutable
artifact preparation to `@supabase/stack`. It downloads or pulls artifacts without starting,
stopping, destroying, or activating any service.

## Files read

- `<workdir>/supabase/config.toml` or `config.json`, plus project dotenv files and supported
  `SUPABASE_*` overrides used by the shared stack config loader.
- `<SUPABASE_HOME or ~/.supabase>/managed/stacks/<stack-id>/state.json` for an existing stack.
- `<SUPABASE_HOME or ~/.supabase>/profile` and an explicitly selected profile when shared settings
  resolve them.
- `<SUPABASE_HOME or ~/.supabase>/telemetry.json` for shared telemetry state.

## Files written

- A managed stack descriptor/state record when the current or named target does not exist.
- Native runtime artifacts in `<SUPABASE_HOME or ~/.supabase>/managed/stacks/artifacts`; container
  images are stored by the selected container engine.
- `<SUPABASE_HOME or ~/.supabase>/telemetry.json` after success or failure once the handler starts.

## Network and subprocesses

Native preparation may download runtime artifacts. Container preparation may contact the configured
container registry and invoke the selected container engine. The package owns preparation,
dependency selection, cache, and cancellation behavior.

## Environment variables

- `SUPABASE_EXPERIMENTAL_STACK` enables (`1`) or disables (`0`) the command family; an unset value
  uses project configuration.
- `SUPABASE_HOME` selects the managed state, artifact cache, profile, and telemetry root.
- `SUPABASE_WORKDIR` selects the project root when no `--workdir` is supplied.
- `SUPABASE_PROFILE` selects the CLI profile.
- `SUPABASE_TELEMETRY_DISABLED` and `DO_NOT_TRACK` suppress telemetry delivery while retaining
  local telemetry state.

## Flags and output

`--stack` and `--stack-id` are mutually exclusive. `--runtime` defaults to `auto` for new stacks;
existing stacks reuse their persisted runtime, and an explicit runtime that differs from an existing
stack fails. When no project configuration exists, the stack package's default settings are used.
With no `--capability`, all enabled capabilities are
prepared. Repeated `--capability` values are passed to the package, which includes dependencies and
rejects unknown capabilities; explicitly disabled capabilities are rejected before preparation.
The legacy `-o/--output` flag is rejected; use
`--output-format`.

Text output lists the stack ID and each prepared capability, version, and outcome (`cached`,
`downloaded`, or `pulled`). JSON output returns `{ id, capabilities, message: "" }`. Stream-JSON
output returns `{ type: "result", data: { id, capabilities, message: "" }, timestamp }`. Errors
use typed actionability and retain package diagnostics.

## Exit codes

- `0` when preparation completes.
- `1` for invalid targets/configuration, unavailable runtime or registry, preparation failures, or
  rejected output flags.

## Telemetry

The command emits the standard `cli_command_executed` event through `withCommandTelemetry` and
flushes telemetry state after successful and failed handler execution. It emits no custom event.
