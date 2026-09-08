# Local stack commands

`supabase stack` manages local stacks with the new runtime. It is available regardless of the project’s backend setting and supports both Docker and native runtimes.

| Command                  | Purpose                                     |
| ------------------------ | ------------------------------------------- |
| `supabase stack start`   | Create or resume the project’s stack.       |
| `supabase stack destroy` | Permanently delete one stack and its data.  |
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

## Service selection and shutdown

`supabase stack start --exclude studio,analytics -x mail` disables those services
in the effective start configuration. Valid names are `rest`, `auth`, `realtime`,
`storage`, `functions`, `studio`, `mail`, `analytics`, and `pooler`; `database` is
required. The project file is unchanged. The effective configuration is retained
in stack state, so stop the stack and start without `--exclude` to restore the
project’s configured services. `--eager` waits for enabled services to become ready.

`supabase stack stop --all` stops every stack in the new backend’s registry and
preserves data. It cannot be combined with `--stack` or `--stack-id`. Failures
are reported after attempting the other stacks.

`supabase stack destroy --stack feature-a` permanently removes exactly that
stack and its data after confirmation. Use `--yes` for unattended execution.
There is no top-level `destroy` alias and no bulk destroy option.

## Exporting environment variables

```sh
supabase stack status --env --output-format text > .env.local
supabase status --env --override-name API_URL=NEXT_PUBLIC_SUPABASE_URL,ANON_KEY=NEXT_PUBLIC_SUPABASE_ANON_KEY
supabase stack status --env --output-format json
```

The top-level example requires the backend flag. `--env` exports URLs and credentials
from a running stack: `DB_URL`, `API_URL`, `ANON_KEY`, `SERVICE_ROLE_KEY`,
`PUBLISHABLE_KEY`, `SECRET_KEY`, and available `STUDIO_URL`, `INBUCKET_URL`,
`S3_PROTOCOL_ACCESS_KEY_ID`, `S3_PROTOCOL_ACCESS_KEY_SECRET`, `S3_PROTOCOL_REGION`,
and `S3_PROTOCOL_URL`. API credentials are omitted when Auth is disabled; optional endpoints and S3
credentials are omitted when unavailable.

Text mode emits dotenv assignments; JSON and stream-JSON modes emit a variable
map. For an explicit dotenv file regardless of automatic agent output detection,
add `--output-format text`. This is dotenv data, not a shell script to execute.
Only this explicit export reveals credentials; ordinary status remains secret-free.
`--override-name` accepts repeated or comma-separated `EXPORTED_VARIABLE=NAME`
entries, requires `--env`, and rejects unknown variables, invalid names, and collisions.
