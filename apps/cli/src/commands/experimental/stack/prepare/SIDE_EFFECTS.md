# `supabase stack prepare`

The command is available when the experimental stack family is enabled. It resolves the selected
project and stack, loads the effective project configuration, and asks the stack package to prepare
the selected service artifacts without starting or changing the saved composition. A new target gets
a managed descriptor so it can later be opened, started, listed, or destroyed.

For each selected creation, the CLI creates a temporary standalone service instance in the target
namespace, runs that instance's `prepare` operation, and destroys that same instance in a scoped
finalizer. Existing composition members and unrelated standalone instances are never adopted or
modified. A preparation failure still runs cleanup for every acquired temporary instance.

## Files read

- `<workdir>/supabase/config.toml`, project dotenv files, and supported `SUPABASE_*` overrides
  used by the shared stack config loader.
- Managed stack state under `<SUPABASE_HOME or ~/.supabase>/stacks/<stack-id>/` when opening an
  existing target.
- Shared profile and telemetry state under `<SUPABASE_HOME or ~/.supabase>/`.

## Files written

- A managed stack descriptor/state record when the target does not exist. Existing records are
  updated while temporary instances and their instance directories are created and removed.
- Runtime artifacts through the selected native or container runtime's package-owned cache.
- Telemetry state after success or failure once the handler starts.

## Network and subprocesses

The resident owner process may be launched and remains available after preparation; `stack stop`
shuts it down. No composition service is started. Native preparation may download runtime artifacts. Container preparation may pull images from the
configured registry and invoke the selected container engine. The stack package owns artifact
caching, preparation, and cancellation; the CLI owns the temporary instance cleanup boundary.

## Flags and output

`--stack` and `--stack-id` are mutually exclusive. `--runtime` defaults to `auto` for new stacks;
existing stacks reuse their persisted runtime, and an explicit mismatch fails. With no
`--capability`, every enabled creation from the effective project configuration is prepared.
Repeated `--capability` includes each capability's configured companion services (Storage/Imgproxy,
Studio/Pgmeta, Analytics/Vector); requesting a disabled service fails before instance preparation. The legacy `-o/--output` flag is rejected; use
`--output-format`.

Text output lists the stack ID and each prepared service and version. JSON output returns the stack
ID and prepared capabilities. Errors retain typed actionability and package diagnostics.

## Exit codes

- `0` when all selected temporary instances prepare and are cleaned up.
- `130` when preparation is interrupted.
- `1` for invalid targets/configuration, unavailable runtime or registry, preparation failures, or
  rejected output flags.

## Telemetry

The command emits the standard `cli_command_executed` event through command telemetry and flushes
telemetry state after successful and failed handler execution. It emits no custom event.
