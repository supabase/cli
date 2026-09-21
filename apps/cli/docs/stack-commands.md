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

`SUPABASE_EXPERIMENTAL_STACK=1 supabase init` writes `[experimental] stack = true` into the new
project config and omits the Docker-era default ports so the stack is not pinned to them.
Without the environment variable, `init` still writes the established template with those ports
and without the stack flag. Blank `supabase bootstrap` uses the same scaffold.

When the flag is on, `--local` targets of the `db`, `migration`, `test db`, `gen types`, and
`inspect` families use the project stack and provision throwaway shadow Postgres through
`@supabase/stack` (`EphemeralPostgres`). Top-level `supabase pull` uses the same stack shadow
as `db pull`. Linked and `--db-url` targets stay on the Management API for engine selection.
A `--db-url` that matches `config.toml` host and port is still rewritten like a published
stack target for dump's tool container. Compose names (`supabase_db_*`, `supabase_network_*`,
`db:5432`) are not used. The stack backend requires the in-process pg-delta engine;
`--use-migra`, `--use-pgadmin`, `--use-pg-schema`, and `db pull --diff-engine migra` are
rejected. The flag does not switch the `functions` command family.

`storage ls`/`cp`/`mv`/`rm` and `seed buckets` (including bucket seeding inside `db reset
--local`) also consult `experimental.stack`, with the same `SUPABASE_EXPERIMENTAL_STACK`
env-precedence rule as `start`/`stop`/`status`. See
[Storage and bucket seeding](#storage-and-bucket-seeding) below. Explicit `--linked`/
`--project-ref` remote targeting for these commands is unaffected by the flag either way.

`db start` brings up a postgres-only project stack on first create. An existing stack resumes
its persisted services (webhooks setup only; no second overlay or migrate-and-seed).
`supabase start` while that postgres-only stack is running stops it and starts the full
configured stack, keeping data. `--from-backup` is not supported on the stack path. `db reset
--local` and declarative `--apply` wipe Postgres through `resetDatabase` and then migrate or
seed on stack credentials.

`gen types --local` and `inspect db … --local` resolve the project stack through the same
`--local` database target as `db dump`. They do not start a stack.

On the stack backend, `db dump --local`, `migration squash`, and `test db` always run catalog
`pg_dump` / `pg_dumpall` / `pg_prove` — native stacks prepend `artifact/bin`, and container
stacks (or platforms with no native artifact: Windows, Intel Mac) run a one-shot of the **same**
catalog Postgres image. There is no host PATH fallback and stack `--local` never uses
`PGHOST=db`. Native `--linked` / `--db-url` keep the resolved host; `--local` native rewrites
loopback to `127.0.0.1`. Missing `pg_prove` fails closed. Install Docker Desktop when a
no-native-artifact platform cannot spawn the one-shot client.

`db lint --local` talks to the running stack over SQL. Catalog Postgres includes
`plpgsql_check`, so native and container stacks can `CREATE EXTENSION` inside the
lint transaction (always rolled back). It does not launch a client binary.

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

## Port intents

Host listener assignment for `supabase stack` is documented in [Port intents](./supabase-home.md#port-intents).

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
Excluding `rest` also disables Studio; excluding `analytics` does not. The effective configuration is
retained in stack state, so starting without `--exclude` restores the project's configured services.

`supabase stack stop --all` stops every readable managed stack while preserving data. It continues
after unreadable entries or individual stop failures, reports a bounded stopped/failed/skipped
summary with per-stack details, and exits nonzero when anything was skipped or failed. Registry-root
enumeration errors remain fatal.

`supabase stack destroy --stack feature-a` permanently removes exactly that stack and its data after
confirmation. Use `--yes` for unattended execution. There is no bulk destroy option.

## Storage and bucket seeding

The `experimental.stack` flag (with the usual `SUPABASE_EXPERIMENTAL_STACK=1|0` env
precedence) routes several command families at once: the top-level `start`/`stop`/`status`
aliases, the `stack` namespace itself, `db`/`migration`/`test`'s `--local` targets (above), and
now `storage ls`/`cp`/`mv`/`rm` and `seed buckets` (including the bucket seeding step inside `db
reset --local`). An explicit `--linked`/`--project-ref` remote target for `storage`/`seed` is
unaffected by the flag either way.

Under the stack backend, `--local` Storage operations resolve their endpoint and credential from
the selected stack rather than `[api]`/`[api.tls]`: the endpoint is the stack's API gateway URL
(`status.endpoints.api.url`) plus `/storage/v1/...`, and the credential is the stack's own
service-role JWT read from its credentials. The stack is located by the project root (workdir
realpath) through the `@supabase/stack` API, which reads stack state under `SUPABASE_HOME`.
None of `storage`, `seed buckets`, or `db reset --local` ever creates a stack; the legacy `[api]`
port/external-URL/TLS fields, their `SUPABASE_API_*` overrides, `SUPABASE_AUTH_JWT_SECRET`/
`SUPABASE_AUTH_SERVICE_ROLE_KEY`, `SUPABASE_SERVICES_HOSTNAME`, the Docker daemon hostname, and
the embedded Kong CA are all legacy-backend only and are not consulted on this path. The
service-role JWT is never printed or logged.

Storage's capability state gates these operations:

| Storage capability state                      | Effect                                                                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disabled` (e.g. `stack start -x storage`)    | Fails with `StackStorageCapabilityError` ("Storage is disabled for this stack."), guiding the user to enable Storage, then run `supabase stack stop` followed by `supabase stack start` without `-x storage`. |
| `failed` / `stopped`                          | Fails with the same `StackStorageCapabilityError` ("Storage failed to start for this stack"/"Storage is stopped for this stack"), guiding the user to `supabase stack restart`.                               |
| `dormant` / `starting` / `ready` / `stopping` | Proceeds immediately; no client-side wait, everywhere `starting` is checked. A `stopping` capability is woken by the gateway once its cleanup completes.                                                      |

A stack that is not registered, not running, missing its API endpoint or credentials, or whose
stack API is unavailable fails instead with `StackStorageUnavailableError`, guiding the user to
run `supabase stack status`/`supabase stack restart`, or `supabase start` when the stack has never
been configured. Missing API credentials because Auth is disabled instead guides the user to
enable `[auth]` in `supabase/config.toml`, then run `supabase stack stop` followed by
`supabase stack start` without `-x auth`. A stack-gateway 502/503 encountered while Storage
activates is reported as `StackStorageCapabilityError` guiding the user to `supabase stack logs`
then `supabase stack restart`, not as a raw status body — but only for a `--local` target; a
`--linked` failure passes through unchanged. All of these failures exit `1` for
`storage`/`seed buckets`, and no HTTP
request is sent when Storage is disabled or the stack is not running.

**Lazy activation.** A `dormant` or `starting` Storage capability is not yet listening; the stack
gateway activates a lazily-configured Storage on the first request that reaches it and holds that
request until it is ready, rather than the CLI polling capability state itself. A request that
arrives while Storage is `stopping` waits for cleanup and then wakes it the same way. `starting`
and `stopping` proceed without waiting everywhere Storage capability is checked, including
`stack start` and `db reset --local`.

**`stack start` seeds on first configured start.** When a `stack start` (or the top-level `start`
under the flag) invocation runs the stack's first configured start (`desiredLifecycle` was
`unconfigured`, including after `stack prepare`) — never when it resumes an existing one — and
Storage is not `disabled`, it seeds `[storage.buckets]` against the stack before printing status,
reusing the `seed buckets` core. A project with no `[storage.buckets]` or
`[storage.vector.buckets]` configured resolves no credentials and prints nothing. Auto-confirm is
safe here since a first-start stack has no pre-existing buckets. Any other unusable Storage state,
a missing capability/credentials, or a
gateway activation failure prints a stderr warning and skips seeding; any other seeding failure
(e.g. an invalid bucket entry) fails the `start` command (exit `1`) but leaves the stack running.
`start` fails only on a genuine seeding error, never on Storage being unavailable. See
[`stack/start/SIDE_EFFECTS.md`](../src/commands/experimental/stack/start/SIDE_EFFECTS.md).

**`db reset --local` never fails for buckets.** Each reset seeds buckets again after the database
reset, when Storage is `ready`, `dormant`, `starting`, or `stopping`. Any other Storage problem —
an unusable capability state, a missing capability/credentials, a gateway activation failure, or
an invalid bucket config — prints `WARNING: skipped seeding storage buckets: <reason> <next step>`
to stderr and the reset still exits `0`. The warning is omitted when the project configures no
buckets, and disabled Storage gets configuration-specific next steps (enable `[storage]`,
`supabase stack stop` then `supabase stack start`, then `supabase seed buckets --local`). When the
underlying stack-storage error carries its own suggestion (a missing API gateway endpoint, Auth
disabled, or a gateway 502/503), that suggestion is the next step instead of the generic
`supabase seed buckets --local` one. This is the
deliberate policy split from `stack start`: the database is already rebuilt by the time buckets
are seeded, so `db reset` never fails the command for a Storage problem, while `start` still fails
on a genuine seeding error. Bucket SQL/schema preparation is the stack runtime's own storage
workload/catalog-setup responsibility; bucket creation and `objects_path` upload from
`[storage.buckets]` remain the CLI's seeding-step responsibility, since the runtime itself never
creates buckets. See [`db/reset/SIDE_EFFECTS.md`](../src/commands/db/reset/SIDE_EFFECTS.md).
