# Local stack commands

`supabase stack` manages local stacks with the new runtime. It is available regardless of the project’s backend setting and supports both Docker and native runtimes.

| Command                  | Purpose                                     |
| ------------------------ | ------------------------------------------- |
| `supabase stack start`   | Create or resume the project’s stack.       |
| `supabase stack stop`    | Stop a stack while retaining its data.      |
| `supabase stack status`  | Inspect stack state and endpoints.          |
| `supabase stack list`    | List registered stacks.                     |
| `supabase stack logs`    | Read or follow service logs.                |
| `supabase stack prepare` | Prepare artifacts before starting services. |
| `supabase stack restart` | Restart an existing stack.                  |

Use each command’s `--help` for its available targeting and runtime options. The previous `supabase experimental stack` command path has been removed.

## Selecting the top-level commands

The top-level `supabase start`, `supabase stop`, and `supabase status` commands use the legacy backend by default. To make them aliases of the corresponding `supabase stack` commands, add this to `supabase/config.toml`:

```toml
[experimental]
stack = true
```

The selected backend determines accepted flags, help, and completion before the command is parsed. Set the flag to `false`, or remove it, to restore the legacy top-level commands. Explicit `supabase stack` commands continue to use the new backend.

For temporary selection, set `SUPABASE_EXPERIMENTAL_STACK=1` to select the new backend or `SUPABASE_EXPERIMENTAL_STACK=0` to select the legacy backend. This environment variable takes precedence over `experimental.stack` in `config.toml`; an unset or empty value falls back to the file setting. Other values are rejected. The override affects only the top-level lifecycle aliases and is applied before reading the project configuration.

This flag currently selects only the `start`, `stop`, and `status` aliases. It does not switch the database, migration, functions, or storage command families to the new backend.

## Data and configuration

The backends own separate state and databases. Enabling the flag does not import, copy, seed from, or reuse the legacy database, and does not stop a running legacy stack. Normal project migrations and seed configuration are separate from importing legacy database data.

The flag is local CLI configuration in `supabase/config.toml` and is excluded from hosted project configuration. When the environment override is absent or empty, lifecycle routing reads that exact file after applying the CLI’s working-directory rules, including `--workdir` and `SUPABASE_WORKDIR`; a JSON-only project does not enable the flag. Selecting a backend does not bypass validation when the selected command later loads its full configuration.
