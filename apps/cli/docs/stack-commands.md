# Local stack commands

`supabase stack` manages local stacks with the new runtime. It is available regardless of the
project's backend setting and supports both Docker and native runtimes.

| Command                | Purpose                                |
| ---------------------- | -------------------------------------- |
| `supabase stack start` | Create or resume the project's stack.  |
| `supabase stack stop`  | Stop a stack while retaining its data. |

The previous `supabase experimental stack` command path has been removed. Use each command's
`--help` for its available targeting and runtime options.

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
command itself. An invalid configuration produces a routing error instead of silently selecting a
backend; set `SUPABASE_EXPERIMENTAL_STACK=0` to select the legacy top-level command explicitly, or
use the explicit `supabase stack start` or `supabase stack stop` command.

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
