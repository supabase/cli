# Local stack commands

`supabase stack` manages local stacks with the new experimental runtime. It is unstable, its
command interface may change, and it is excluded from the CLI compatibility promise. It is
available regardless of the project's backend setting and supports both Docker and native runtimes.

| Command                  | Purpose                                    |
| ------------------------ | ------------------------------------------ |
| `supabase stack start`   | Create or resume the project's stack.      |
| `supabase stack destroy` | Permanently delete one stack and its data. |
| `supabase stack stop`    | Stop a stack while retaining its data.     |

Use each command's `--help` for its available targeting and runtime options.

## Selecting the top-level commands

The top-level `supabase start` and `supabase stop` commands use the legacy backend by default.
To make them aliases of the corresponding `supabase stack` commands, add this to
`supabase/config.toml`:

```toml
[experimental]
stack = true
```

The selected backend determines accepted flags, help, and completion before the command is parsed.
Set the flag to `false`, or remove it, to restore the legacy top-level commands. Explicit
`supabase stack` commands always use the new backend. `supabase status` always uses its existing
command implementation and is unaffected by this flag.

Root help and root completion do not read project configuration, so they remain available without
a project directory. Help and completion for `start` and `stop` resolve the same backend as the
command itself. If the project configuration cannot be read or parsed, or if
`experimental.stack` has an invalid value, routing falls back to the legacy backend. An invalid
`SUPABASE_EXPERIMENTAL_STACK` value is still an error; set it to `0` to select the legacy
top-level command explicitly, or use the explicit `supabase stack start` or `supabase stack stop`
command.

For temporary selection, set `SUPABASE_EXPERIMENTAL_STACK=1` to select the new backend or
`SUPABASE_EXPERIMENTAL_STACK=0` to select the legacy backend. This environment variable takes
precedence over `experimental.stack`; an unset or empty value falls back to the file setting.
Other values are rejected. The override affects only the top-level lifecycle aliases and is
applied before reading the project configuration.

## Data and configuration

The backends own separate state and databases. Enabling the flag does not import, copy, seed from,
or reuse the legacy database, and does not stop a running legacy stack. Normal project migrations
and seed configuration are separate from importing legacy database data.

The flag is local CLI configuration in `supabase/config.toml` and is excluded from hosted project
configuration. Routing reads that exact file after applying the CLI's working-directory rules,
including `--workdir` and `SUPABASE_WORKDIR`; a JSON-only project does not enable the flag.

## Service selection and shutdown

`supabase stack start --exclude studio,analytics -x mail` disables those services in the effective
start configuration without changing the project file. Valid names are `rest`, `auth`, `realtime`,
`storage`, `functions`, `studio`, `mail`, `analytics`, and `pooler`; the database is required. The
effective configuration is retained in stack state, so starting without `--exclude` restores the
project's configured services.

`supabase stack stop --all` stops every readable managed stack while preserving data. It continues
after unreadable entries or individual stop failures, reports warnings and counts, and exits
nonzero when anything was skipped or failed. Registry-root enumeration errors remain fatal.

`supabase stack destroy --stack feature-a` permanently removes exactly that stack and its data after
confirmation. Use `--yes` for unattended execution. There is no bulk destroy option.
