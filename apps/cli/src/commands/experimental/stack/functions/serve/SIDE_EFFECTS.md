# `supabase functions serve` with the managed stack backend

## Files read

- The selected project's `supabase/config.toml` and project environment files are read through the managed stack config loader.
- `supabase/functions/.env` and per-Function `.env` files are read when `--env-file` is absent.
- An explicit `--env-file` or `--import-map` is resolved from the caller's current directory.
- The selected stack's persisted state, owner metadata, and Functions logs are read through `@supabase/stack`.

## Files written

- The command does not write project files or durable stack configuration.
- The existing stack owner may update runtime artifacts and retained logs while replacing its Functions workload.
- Telemetry state is flushed when the command exits.

## Runtime behavior

- The command opens only the implicit managed stack for the current project. It never creates, stops, or destroys a stack.
- Invocation-only env, import-map, JWT, inspector, and debug settings are applied to a transient Functions activation.
- The Functions workload shares the selected stack's database, gateway, credentials, and ports.
- Function source, environment, import-map, and project configuration changes restart the transient Functions activation.
- Function logs are streamed until the stack stops or the command receives `SIGINT`, `SIGTERM`, or `SIGHUP`.
- Exiting the command restores the durable Functions activation and leaves the selected stack and its other capabilities running.
