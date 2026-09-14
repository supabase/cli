# Local stack commands

`supabase stack` manages local stacks with the new experimental runtime. It is unstable, its
command interface may change, and it is excluded from the CLI compatibility promise. It is
available when the `experimental.stack` feature flag is enabled and supports both Docker and
native runtimes.

| Command                  | Purpose                                    |
| ------------------------ | ------------------------------------------ |
| `supabase stack start`   | Create or resume the project's stack.      |
| `supabase stack logs`    | Read retained or live stack logs.          |
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
Set the flag to `false`, or remove it, to restore the legacy top-level commands. The explicit
`supabase stack` namespace is available only when this flag is enabled. `supabase status` always
uses its existing command implementation and is unaffected by this flag.

Root help and root completion resolve the same feature flag from the environment or project
configuration. Help and completion for `start` and `stop` resolve the same
backend as the command itself. If the project configuration cannot be read or parsed, or if
`experimental.stack` has an invalid value, routing falls back to the legacy backend and the stack
namespace remains unavailable. An invalid `SUPABASE_EXPERIMENTAL_STACK` value is still an error.

For temporary selection, set `SUPABASE_EXPERIMENTAL_STACK=1` to select the new backend or
`SUPABASE_EXPERIMENTAL_STACK=0` to select the legacy backend. This environment variable takes
precedence over `experimental.stack`; an unset or empty value falls back to the file setting.
Other values are rejected. The override is applied before reading the project configuration.

## Reading stack logs

`supabase stack logs` reads retained logs without starting or stopping the selected stack. Use
`--stack <name>` or `--stack-id <id>` to select a stack, `--service <name>` to filter services,
and `--tail <count>` to bound retained history. Add `--follow` (or `-f`) to continue with new
entries; `--tail 0` starts with live entries only. Follow mode leaves the stack running when
interrupted.

The default text output is one `<timestamp> <service>/<stream>: <message>` line per entry.
`--output-format json` returns one bounded object. A found stack has this shape, with the raw
entry message preserved:

```json
{
  "found": true,
  "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "entries": [
    {
      "cursor": { "opaque": "1" },
      "timestamp": "2026-09-08T00:00:00.000Z",
      "source": "database",
      "stream": "stdout",
      "message": "database ready"
    }
  ],
  "cursor": { "opaque": "1" },
  "running": false,
  "message": ""
}
```

When no default stack exists, JSON output is:

```json
{
  "found": false,
  "entries": [],
  "message": "No managed stack found for this context."
}
```

`--output-format stream-json` emits one `log-entry` event for each history or live entry, with
the original message in `line`. For an absent default stack it emits the standard empty result
envelope:

```json
{
  "type": "result",
  "data": {
    "found": false,
    "entries": [],
    "message": "No managed stack found for this context."
  },
  "timestamp": "..."
}
```

A found stack with no entries emits no events. The command is available only while
`experimental.stack` is enabled.

## Data and configuration

The backends own separate state and databases. Enabling the flag does not import, copy, seed from,
or reuse the legacy database, and does not stop a running legacy stack. Normal project migrations
and seed configuration are separate from importing legacy database data.

The flag is local CLI configuration in `supabase/config.toml` or `supabase/config.json` and is
excluded from hosted project configuration. Routing applies the CLI's working-directory rules,
including `--workdir` and `SUPABASE_WORKDIR`, and prefers JSON when both files exist.

## Service selection and shutdown

`supabase stack start --exclude studio,analytics -x mail` disables those services in the effective
start configuration without changing the project file. Valid names are `rest`, `auth`, `realtime`,
`storage`, `functions`, `studio`, `mail`, `analytics`, and `pooler`; the database is required.
Excluding `rest` or `analytics` also disables Studio. The effective configuration is
retained in stack state, so starting without `--exclude` restores the project's configured services.

`supabase stack stop --all` stops every readable managed stack while preserving data. It continues
after unreadable entries or individual stop failures, reports a bounded stopped/failed/skipped
summary with per-stack details, and exits nonzero when anything was skipped or failed. Registry-root
enumeration errors remain fatal.

`supabase stack destroy --stack feature-a` permanently removes exactly that stack and its data after
confirmation. Use `--yes` for unattended execution. There is no bulk destroy option.
