# Local stack commands

`supabase stack` manages local stacks with the new experimental runtime. It is unstable, its
command interface may change, and it is excluded from the CLI compatibility promise. It is
available regardless of the project's backend setting and supports both Docker and native runtimes.

| Command                 | Purpose                                                                           |
| ----------------------- | --------------------------------------------------------------------------------- |
| `supabase stack start`  | Create or resume the project's stack.                                             |
| `supabase stack status` | Show identity, readiness, and drift, or export connection variables with `--env`. |
| `supabase stack stop`   | Stop a stack while retaining its data.                                            |

Use each command's `--help` for its available targeting and runtime options.

## Exporting environment variables

```sh
supabase stack status --env --output-format text > .env.local
supabase status --env --override-name API_URL=NEXT_PUBLIC_SUPABASE_URL,ANON_KEY=NEXT_PUBLIC_SUPABASE_ANON_KEY
supabase stack status --env --output-format json
```

The top-level example requires the stack backend flag described below. `--env` exports the
connection URLs and credentials of the running stack; text mode emits dotenv assignments, and JSON
or stream-JSON mode emits a variable map. Add `--output-format text` for an explicit dotenv file
regardless of automatic agent output detection; this is dotenv data, not a shell script. Only this
explicit export reveals credentials. Ordinary status remains free of secrets. `--override-name`
accepts repeated or comma-separated `EXPORTED_VARIABLE=NAME` entries, requires `--env`, and rejects
unknown variables, invalid names, and collisions. API credentials are omitted when Auth is disabled.

The legacy `supabase status -o env` form is rejected on the stack backend; use `--env` instead.

## Selecting the top-level commands

The top-level `supabase start`, `supabase stop`, and `supabase status` commands use the legacy
backend by default. To make them aliases of the corresponding `supabase stack` commands, add this
to `supabase/config.toml`:

```toml
[experimental]
stack = true
```

The selected backend determines accepted flags, help, and completion before the command is parsed.
Set the flag to `false`, or remove it, to restore the legacy top-level commands. Explicit
`supabase stack` commands always use the new backend; `supabase status` is routed the same way as
`supabase start` and `supabase stop`.

Root help and root completion do not read project configuration, so they remain available without
a project directory. Help and completion for `start`, `status`, and `stop` resolve the same backend
as the command itself. If the project configuration cannot be read or parsed, or if
`experimental.stack` has an invalid value, routing falls back to the legacy backend. An invalid
`SUPABASE_EXPERIMENTAL_STACK` value is still an error; set it to `0` to select the legacy
top-level command explicitly, or use the explicit `supabase stack start`, `supabase stack status`,
or `supabase stack stop` command.

For temporary selection, set `SUPABASE_EXPERIMENTAL_STACK=1` to select the new backend or
`SUPABASE_EXPERIMENTAL_STACK=0` to select the legacy backend. This environment variable takes
precedence over `experimental.stack`; an unset or empty value falls back to the file setting.
Other values are rejected. The override affects only the top-level `start`, `status`, and `stop`
aliases and is applied before reading the project configuration.

## Data and configuration

The backends own separate state and databases. Enabling the flag does not import, copy, seed from,
or reuse the legacy database, and does not stop a running legacy stack. Normal project migrations
and seed configuration are separate from importing legacy database data.

The flag is local CLI configuration in `supabase/config.toml` and is excluded from hosted project
configuration. Routing reads that exact file after applying the CLI's working-directory rules,
including `--workdir` and `SUPABASE_WORKDIR`; a JSON-only project does not enable the flag.
