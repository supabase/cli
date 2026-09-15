# `supabase functions serve` with the managed stack backend

## Files read

- The selected project's `supabase/config.toml` is read before every activation.
- Project dotenv candidates are read from both the project root and `supabase/` in this order:
  `.env.<SUPABASE_ENV>.local`, `.env.local`, `.env.<SUPABASE_ENV>`, `.env`. `SUPABASE_ENV`
  defaults to `development`; `.env.local` is omitted for `test`.
- `supabase/functions/.env` and per-Function `.env` files are read when `--env-file` is absent.
- An explicit `--env-file` or `--import-map` is resolved from the caller's current directory.
  `--env-file` disables automatic shared and per-Function env discovery.
- The selected stack's persisted state, owner metadata, and Functions logs are read through `@supabase/stack`.

## Files written

- The command does not write project files or durable stack configuration.
- The stack package may update its private state, runtime artifacts, transient secret material, and retained logs while replacing its Functions workload.
- Telemetry state is flushed when the command exits.

## Runtime behavior

- `SUPABASE_EXPERIMENTAL_STACK=1` selects this backend; `0` selects legacy serve. When unset or empty, `[experimental].stack` selects it. Other values fail before command dispatch.
- The command opens only the implicit managed stack for the current project. It never creates, starts, stops, or destroys a stack. A missing or stopped stack is an actionable lifecycle error; disabled Functions is an actionable configuration error.
- Invocation-only env, import-map, JWT, inspector, and debug settings are applied to a transient Functions activation.
- The Functions workload shares the selected stack's database, gateway, credentials, and ports.
- One opaque session ID owns the initial activation, every reload, the termination wait, and restoration. Other sessions cannot replace it.
- The watcher covers `supabase/functions/` recursively. It separately matches `supabase/config.toml`, every selected project dotenv candidate in both directories, and explicit env/import-map files so creation, update, and deletion trigger a reload.
- Function logs, the watcher, process-signal handling, and runtime termination are observed concurrently.
- `SIGINT`, `SIGTERM`, and `SIGHUP` cancel command-owned work, restore the durable Functions activation, and leave the stack and its other capabilities running.
- An external stack stop exits cleanly without racing it with a restore. Unexpected Functions termination while the stack remains running fails and attempts restoration. If both serving and restoration fail, both causes are preserved.

## Output

- Setup diagnostics, reserved `SUPABASE_*` env warnings, and file-change diagnostics are written to stderr.
- The serving URL, redacted application logs, and final `Stopped serving supabase/functions` line are written to stdout in text mode.
- Known config and invocation secret values are redacted before logs are retained or forwarded.
