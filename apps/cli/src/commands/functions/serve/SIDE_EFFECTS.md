# `supabase functions serve`

`functions serve` is a client of the managed `@supabase/stack` runtime. It does not create,
restart, watch, or remove an Edge Runtime container directly.

## Files read

- `supabase/config.toml` and the project configuration inputs used by the shared config loader.
- `supabase/functions/**` while inferring the Functions manifest when function-specific flags need
  it. The running stack reads function sources from this root on each request, so edits do not
  restart the service.
- The explicit `--env-file`, when supplied. Its values are persisted as redacted managed-stack
  settings. Without this flag, the Functions runtime owns its normal environment-file discovery.

The command writes no project-local runtime files. Managed state, logs, artifacts, secrets, and
runtime resources are owned by `@supabase/stack` under the configured Supabase home.

## Runtime behavior

1. Validate flags and translate the CLI configuration to a stack configuration.
2. Create or open the default managed stack identity and call `stack.start()`.
3. Wait until the stack gateway is running and the Functions capability is either ready or dormant.
   A dormant Functions service remains lazy and activates on its first request.
4. Print the Functions gateway URL and follow only Functions logs.
5. Stop following logs on `SIGINT`, `SIGTERM`, or stdin shutdown.

Exiting this command does not stop the managed stack. An explicit stack stop or destroy owns that
lifecycle. Stopped-time configuration changes and incompatible live-owner releases are reported as
typed errors with restart guidance.

## Output and telemetry

- Text output reports the managed-stack lifecycle, gateway URL, and live Functions log entries.
- JSON output uses the shared command output/error boundary.
- The legacy command wrapper records and flushes its normal command telemetry on success or failure.

Any positional Function names and the hidden `--all` flag remain accepted for CLI compatibility;
the managed runtime serves all functions discovered under `supabase/functions`.
