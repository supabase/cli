# Local stack commands

`supabase stack` manages local stacks with the new experimental runtime. It is unstable, its
command interface may change, and it is excluded from the CLI compatibility promise. It is
available when the `experimental.stack` feature flag is enabled and supports both Docker and
native runtimes.

| Command                  | Purpose                                                                           |
| ------------------------ | --------------------------------------------------------------------------------- |
| `supabase stack destroy` | Permanently delete one stack and its data.                                        |
| `supabase stack list`    | List persisted managed local stacks.                                              |
| `supabase stack prepare` | Download artifacts without starting services.                                     |
| `supabase stack start`   | Create or resume the project's stack.                                             |
| `supabase stack status`  | Show identity, readiness, and drift, or export connection variables with `--env`. |
| `supabase stack logs`    | Read retained or live stack logs.                                                 |
| `supabase stack restart` | Restart an existing stack using its saved effective configuration.                |
| `supabase stack stop`    | Stop a stack while retaining its data.                                            |

Use each command's `--help` for its available targeting and runtime options.

`supabase stack prepare` downloads or pulls artifacts for the selected stack without starting
services. If the target does not exist, prepare creates and registers it; the stack then appears in
`supabase stack list` and can be removed with `supabase stack destroy`. Omit `--capability` to
prepare every enabled capability, or repeat `--capability` up to ten times to select specific
capabilities. Each occurrence names one capability; use separate flags rather than CSV.

```sh
supabase stack prepare
supabase stack prepare --capability rest --capability auth --output-format json
```

## Exporting environment variables

```sh
supabase stack status --env --output-format text > .env.local
supabase status --env --override-name API_URL=NEXT_PUBLIC_SUPABASE_URL,ANON_KEY=NEXT_PUBLIC_SUPABASE_ANON_KEY
supabase stack status --env --output-format json
```

Each example requires the stack backend flag described below. `--env` exports the connection URLs
and credentials of the running stack; text mode emits dotenv assignments, and JSON
or stream-JSON mode emits a variable map. Add `--output-format text` for an explicit dotenv file
regardless of automatic agent output detection; this is dotenv data, not a shell script, and values
are quoted so that sourcing the file performs no shell expansion. Only this
explicit export reveals credentials. Ordinary status remains free of secrets. `--override-name`
accepts repeated or comma-separated `EXPORTED_VARIABLE=NAME` entries, requires `--env`, and rejects
unknown variables, invalid names, and collisions. API credentials are omitted when Auth is disabled.

The stack backend rejects every explicit legacy `-o/--output` value: `env`, `pretty`, `json`,
`toml`, `yaml`, `table`, and `csv`. `--output-format text`, `json`, or `stream-json` replace them.
`-o env` becomes `--env`.

`supabase stack list` reads the global managed-stack registry and reports each readable stack's
project, branch, runtime, and desired lifecycle. Corrupt or unsupported registry entries are
included in a diagnostic section with their full IDs and error reasons, and do not hide readable
entries. The text table shortens readable IDs for scanning; use `--output-format json` or
`--output-format stream-json` for the complete structured inventory with full IDs.

Listing is global and has no checkout filter. Desired lifecycle is persisted intent, so `running`
does not prove a live owner exists. Use `supabase stack status` for live state. Registry directories
without a state file are ignored as remnants.

## Selecting the top-level commands

The top-level `supabase start`, `supabase stop`, and `supabase status` commands use the legacy
backend by default. To make them aliases of the corresponding `supabase stack` commands, add this
to `supabase/config.toml`:

```toml
[experimental]
stack = true
```

The selected backend determines accepted flags, help, and completion before the command is parsed.
Set the flag to `false`, or remove it, to restore the legacy top-level commands. The explicit
`supabase stack` namespace is available only when this flag is enabled. `supabase status` is routed
the same way as `supabase start` and `supabase stop`.

Root help and root completion resolve the same feature flag from the environment or project
configuration. Help and completion for `start`, `status`, and `stop` resolve the same backend as the
command itself. If the project configuration cannot be read or parsed, or if `experimental.stack`
has an invalid value, routing falls back to the legacy backend and the stack namespace remains
unavailable. An invalid `SUPABASE_EXPERIMENTAL_STACK` value is still an error.

For temporary selection, set `SUPABASE_EXPERIMENTAL_STACK=1` to select the new backend or
`SUPABASE_EXPERIMENTAL_STACK=0` to select the legacy backend. This environment variable takes
precedence over `experimental.stack`; an unset or empty value falls back to the file setting.
Other values are rejected. The override is applied before reading the project configuration.

## Reading stack logs

`supabase stack logs` reads retained logs without starting or stopping the selected stack. Use
`--stack <name>` or `--stack-id <id>` to select a stack, `--service <name>` to filter services,
and `--tail <count>` to bound retained history (`0` through `1000`, default `100`). `--service`
accepts one capability name; it excludes supervisor and gateway entries, including their startup
diagnostics. Omit it to include all retained sources. Retention is bounded to the newest 1000
entries or 1 MiB, whichever is reached first.
Add `--follow` (or `-f`) to continue with new entries; `--tail 0` starts with live entries only.
Follow mode leaves the stack running when interrupted.

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

`--output-format stream-json` emits one bounded result event for a finite read. With `--follow`,
it emits one `log-entry` event for each history or live entry, with the original message in
`line`. For an absent default stack it emits the standard empty result envelope:

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

A found stack with no entries emits a result event for a finite stream-json read. Follow mode
emits only log-entry events; a found stack with no retained entries emits no follow events, and a
stopped stack exits successfully. The command is available only while `experimental.stack` is
enabled.

## Data and configuration

The backends own separate state and databases. Enabling the flag does not import, copy, seed from,
or reuse the legacy database, and does not stop a running legacy stack. Normal project migrations
and seed configuration are separate from importing legacy database data.

The flag is local CLI configuration in `supabase/config.toml` or `supabase/config.json` and is
excluded from hosted project configuration. Routing applies the CLI's working-directory rules,
including `--workdir` and `SUPABASE_WORKDIR`, and prefers JSON when both files exist.

## Service selection and shutdown

With the current defaults, lazy REST, Auth, Realtime, Studio, and pooler services stop after 60 seconds without traffic. An
active HTTP request keeps a capability running; an idle HTTP keep-alive socket does not. Open
WebSocket or TCP connections keep a capability running during idle periods. Use `supabase stack start --eager` to activate all enabled capabilities and
disable automatic idle stops. Per-capability `idleTimeoutSeconds` values are available through the
package's Effect API only; the CLI does not expose them as command or project configuration
settings. A request arriving while a capability is stopping waits for cleanup and then wakes it
when the stack still permits activation. Manual `supabase stack stop` prevents wake up until the
stack is started again. A cleanup failure can block new connections until `stop` and `start`
complete recovery; a destroy failure can be retried with `destroy`.

`supabase stack restart` reuses an existing stack's saved effective configuration. It stops and
starts the same stack identity, preserving its data. Normal startup may still download missing
artifacts according to the saved preparation policy. Select a stack with `--stack <name>` or
`--stack-id <id>`. The restart handler does not reload project configuration. Set
`SUPABASE_EXPERIMENTAL_STACK=1` when restarting by ID outside the project or with invalid project
configuration, so feature routing does not depend on that configuration. Start flags such as `--exclude`, `--eager`, or
`--preparation` remain in the saved stack configuration; a later normal `start` reloads the project
configuration and current flags.
Stacks saved before idle stopping keep it disabled when restarted. To adopt the current defaults,
run `supabase stack stop` followed by `supabase stack start`. Status can report changed effective
defaults even when the project file is unchanged; a stack still marked running must be stopped
before those defaults can be applied.
An unconfigured stack must be initialized with `supabase stack start` before it can be restarted.

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
