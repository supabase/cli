# `supabase stack restart`

Restarts the selected saved application composition. It preserves member IDs,
data, ports, dependency bindings, and activation settings. Standalone instances
and their jobs are not part of this restart. The experimental feature flag
controls command registration.

## Selection and configuration

Select the current project/branch/name, `--stack <name>`, or `--stack-id <id or unique prefix>`.
The selectors are mutually exclusive. Missing or unconfigured stacks fail with
guidance to run `stack start`. Explicit legacy `-o/--output` is rejected in favor
of `--output-format`.

Restart uses saved configuration; it does not load, compare, or apply project
config changes. To change participating services, use `stack start --exclude`
with the desired selection. Configuration replacement is not implied by restart.

## Files and network

Reads the selected state under `<SUPABASE_HOME or ~/.supabase>/stacks/<id>/`.
Discovery ensures the registry directory exists with mode 0700 and probes local
owners. An owner may be launched by restart when none exists. Existing runtime
resources are stopped/recreated for composition members only. Artifacts are
resolved from `<SUPABASE_HOME or ~/.supabase>/cache/stack`; missing artifacts may
be downloaded. Shared routing/settings may read project config and profiles.
No hosted project API calls or caller-owned data deletion occur. On a stack
started with `[api.tls]` on Docker or Podman, the database container then calls
the API once in plain with the token the last `stack start` saved. Without an HTTP
reply, restart stops the stack's services and fails with ``api.tls: containers
can't reach the api on <runtime> (<what the probe saw>); its services stopped: let
<runtime> containers reach the api port, or turn off `[api.tls]`, then start the
stack again``; if they don't stop, the error says to run `supabase stack stop`
instead.

## Output, exit codes and telemetry

Text identifies that saved configuration was used and lists each member's
lifecycle and health separately. JSON/stream-json results contain stack `id` and
`services` entries with instance `id`, `service`, `lifecycle`, `health`, and
`wake_enabled`. Runtime secrets/configuration are not serialized into results.

Exit 0 on success, 1 on selection/configuration/runtime failure, 130 on
interruption. Standard command telemetry is retained, with no custom events.
Telemetry flushes on every exit to
`<SUPABASE_HOME or ~/.supabase>/telemetry.json`.
