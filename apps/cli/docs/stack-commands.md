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
| `supabase stack logs`    | Stream live stack logs.                                                           |
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
and credentials available from the observed composition; text mode emits dotenv assignments, and
JSON or stream-JSON mode emits a variable map. Values that are unavailable because a member is
stopped or unhealthy are omitted. Add `--output-format text` for an explicit dotenv file
regardless of automatic agent output detection; this is dotenv data, not a shell script, and values
are quoted so that sourcing the file performs no shell expansion. Only this
explicit export reveals credentials. Ordinary status remains free of secrets. `--override-name`
accepts repeated or comma-separated `EXPORTED_VARIABLE=NAME` entries, requires `--env`, and rejects
unknown variables, invalid names, and collisions. The DB-derived service-role JWT remains available
when Auth is disabled; unavailable service URLs and credentials are omitted.

The stack backend rejects every explicit legacy `-o/--output` value: `env`, `pretty`, `json`,
`toml`, `yaml`, `table`, and `csv`. `--output-format text`, `json`, or `stream-json` replace them.
`-o env` becomes `--env`.

`supabase stack list` reads the global managed-stack registry and reports each readable stack's
project, branch, runtime, and owner availability. A corrupt or unsupported registry entry fails the
whole discovery operation with a diagnostic; readable entries are not emitted as a partial list.
The text table shortens readable IDs for scanning; use `--output-format json` or
`--output-format stream-json` for the complete structured inventory with full IDs.

Listing is global and has no checkout filter. Owner availability is not service lifecycle or health;
use `supabase stack status` for live state. Registry directories without a state file are ignored
as remnants.

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

When the flag is on, `--local` targets of the `db`, `migration`, `test db`, `gen types`, and
`inspect` families use the project stack and provision a throwaway shadow database owned by the
stack runtime. Top-level `supabase pull` uses the same stack shadow
as `db pull`. Linked and `--db-url` targets stay on the Management API for engine selection.
A `--db-url` that matches `config.toml` host and port is still rewritten like a published
stack target for dump's tool container. Compose names (`supabase_db_*`, `supabase_network_*`,
`db:5432`) are not used. The stack backend requires the in-process pg-delta engine;
`--use-migra`, `--use-pgadmin`, `--use-pg-schema`, and `db pull --diff-engine migra` are
rejected. The flag also routes local `functions serve` through the stack; other `functions`
commands retain their existing behavior.

`functions serve` requires a running project stack. It attaches to the existing Functions member,
waking it when needed. If Functions was excluded, it creates a temporary standalone Functions
instance on the stack's API listener without changing the saved composition. Ctrl-C destroys that
temporary instance; an existing member remains available. `--no-verify-jwt` and `--env-file` apply
for the serving session and the previous configuration is restored on exit. Ordinary code edits
are picked up by the next invocation without a runtime restart. Import-map and inspector flags
and multiline environment values are currently unsupported on this backend. Normal exit owns cleanup; forcibly killing the CLI
cannot guarantee restoration or removal of its temporary instance. Concurrent override sessions
for the same Functions instance are unsupported. Cleanup waits for submitted lifecycle operations;
additional signals do not force it to abandon cleanup. Restoration restores configuration and keeps
the service running; it does not return it to a sleeping state.

Stack mode reads the shared `supabase/functions/.env` file when creating Functions; `--env-file`
replaces those custom values for the session. A normal `start` applies changes to the shared file
and restores default JWT verification on the same Functions instance. Per-function
`.env` files are not loaded. Reserved
`SUPABASE_*` values in these files are ignored because the runtime supplies them. With
`--output-format stream-json`, readiness emits a result containing the instance ID and URL,
followed by live log events.

`storage ls`/`cp`/`mv`/`rm` and `seed buckets` (including bucket seeding inside `db reset
--local`) also consult `experimental.stack`, with the same `SUPABASE_EXPERIMENTAL_STACK`
env-precedence rule as `start`/`stop`/`status`. See
[Storage and bucket seeding](#storage-and-bucket-seeding) below. Explicit `--linked`/
`--project-ref` remote targeting for these commands is unaffected by the flag either way.

`db start` brings up a postgres-only project stack on first create. An existing stack resumes its
primary database without changing other services (webhooks setup only; no second overlay or
migrate-and-seed).
`supabase start` while that postgres-only stack is running stops it and starts the full
configured stack, keeping data. `--from-backup` is not supported on the stack path.
`db reset --local` and declarative resets rebuild the existing database while retaining stack
identity, ports, and composition. See
[`db/reset/SIDE_EFFECTS.md`](../src/commands/db/reset/SIDE_EFFECTS.md).

`gen types --local` and `inspect db … --local` resolve the project stack through the same
`--local` database target as `db dump`. They do not start a stack.

On the stack backend, `db dump --local`, `migration squash`, and `test db --local` run
catalog tools attached to their owning stack. Tools use runtime-facing database addresses;
`test db` preserves the user, password, and database selected by the CLI resolver.

External `--linked` and `--db-url` tools use CLI-owned adapters without creating a stack.
Supported native platforms run the bundled executable with `artifact/bin` on PATH. Other
platforms use a one-shot container from the catalog Postgres image. Neither path falls back to
host-installed PostgreSQL tools. Missing tools fail closed; container execution requires Docker.

`db lint --local` talks to the running stack over SQL. Catalog Postgres includes
`plpgsql_check`, so native and container stacks can `CREATE EXTENSION` inside the
lint transaction (always rolled back). It does not launch a client binary.

## Reading stack logs

`supabase stack logs` streams live stdout/stderr from composition members without
starting an owner or service. Select `--stack <name>` or `--stack-id <id>`;
`--service <kind-or-instance-id>` can include standalone services too. The command
requires a reachable owner and streams until interrupted. Ctrl-C leaves services
running. There is no retained history, `--tail`, or `--follow` flag.

Text uses `<timestamp> <service>/<instance-id>/<stream>: <line>` and strips terminal
control sequences. For automation use `--output-format stream-json`: each
`log-entry` contains `timestamp`, `service`, `instance_id`, `stream`, `line`, and
`source: "live"`. Finite JSON output is not supported. Delivery is best effort;
stdout/stderr and different services may interleave. Missing stacks, unavailable
owners, and unmatched services fail with status 1; interruption exits 130.

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

With the current defaults, enabled non-database services with endpoints are lazy and stop after
60 seconds without traffic; Functions has no automatic idle stop. An active HTTP request keeps a
capability running; an idle HTTP keep-alive socket does not. Open WebSocket or TCP connections
keep a capability running during idle periods. Use `supabase stack start --eager` to activate all
enabled capabilities and disable automatic idle stops. A request arriving while a capability is
stopping waits for cleanup and then wakes it when the stack still permits activation. Manual
`supabase stack stop` prevents wake up until the stack is started again. A cleanup failure can
block new connections until `stop` and `start` complete recovery; a destroy failure can be retried
with `destroy`.

`supabase stack restart` reuses an existing stack's saved effective configuration. It stops and
starts the same stack identity, preserving its data. Normal startup may still download missing
artifacts using its current preparation policy. Select a stack with `--stack <name>` or
`--stack-id <id>`. The restart handler does not reload project configuration. Set
`SUPABASE_EXPERIMENTAL_STACK=1` when restarting by ID outside the project or with invalid project
configuration, so feature routing does not depend on that configuration. Start selection and
activation flags such as `--exclude` and `--eager` remain in the saved stack configuration;
`--preparation` applies only to that invocation. A later normal `start` reloads the project
configuration and current flags.
An unconfigured stack must be initialized with `supabase stack start` before it can be restarted.

`supabase stack start --exclude studio,analytics -x mail` disables those services in the effective
start configuration without changing the project file. Valid names are `rest`, `auth`, `realtime`,
`storage`, `functions`, `studio`, `mail`, `analytics`, and `pooler`; the database is required.
Excluding `rest` while Studio remains selected is rejected; excluding `analytics` does not affect
Studio. The effective configuration is
retained in stack state, so starting without `--exclude` restores the project's configured services.

`supabase stack stop --all` stops every managed stack while preserving data. Discovery fails closed
when any registry entry is unreadable, so no partial stop operation is attempted. Individual stop
failures make the command fail and identify the affected stack IDs with their error details; no
success or unavailable summary is emitted when a stop fails.

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
the selected composition rather than `[api]`/`[api.tls]`: the endpoint is the Storage member's
observed HTTP binding plus `/storage/v1/...`, and the service-role JWT is generated from the
primary database member's observed JWT secret. The stack is located by the project root
(workdir realpath) through the `@supabase/stack` API, which reads stack state under
`SUPABASE_HOME`.
Neither `storage` nor `seed buckets` ever creates a stack; the legacy `[api]`
port/external-URL/TLS fields, their `SUPABASE_API_*` overrides, `SUPABASE_AUTH_JWT_SECRET`/
`SUPABASE_AUTH_SERVICE_ROLE_KEY`, `SUPABASE_SERVICES_HOSTNAME`, the Docker daemon hostname, and
the embedded Kong CA are all legacy-backend only and are not consulted on this path. The
service-role JWT is never printed or logged.

Storage's capability state gates these operations:

| Storage capability state                   | Effect                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disabled` (e.g. `stack start -x storage`) | Fails with `StackStorageCapabilityError` ("Storage is disabled for this stack."), guiding the user to enable Storage and run `supabase stack start` without `-x storage`.       |
| `failed` / `stopped`                       | Fails with the same `StackStorageCapabilityError` ("Storage failed to start for this stack"/"Storage is stopped for this stack"), guiding the user to `supabase stack restart`. |
| `dormant` / `starting` / `ready`           | Proceeds immediately; the gateway handles lazy activation without client-side waiting.                                                                                          |
| `stopping` with wake retained (idle stop)  | Proceeds immediately; the gateway waits for cleanup and wakes Storage.                                                                                                          |
| `stopping` after manual `stack stop`       | Fails like `stopped` because manual stop disables wake-up until the stack starts again.                                                                                         |

A stack that is not registered, not running, has no primary database, or whose stack API is
unavailable fails with `StackStorageUnavailableError`, guiding the user to run `supabase stack
status`/`supabase stack restart`, or `supabase start` when the stack has never been configured.
Missing Storage HTTP endpoints fail with `StackStorageCapabilityError`, as do other Storage
capability failures. A stack-gateway 502/503 encountered while Storage activates is reported as
`StackStorageCapabilityError` guiding the user to `supabase stack logs` then `supabase stack
restart`, not as a raw status body — but only for a `--local` target; a `--linked` failure passes
through unchanged. All of these failures exit `1` for
`storage`/`seed buckets`, and no HTTP
request is sent when Storage is disabled or the stack is not running.

**Lazy activation.** A `dormant` or `starting` Storage capability is not yet listening; the stack
gateway activates a lazily-configured Storage on the first request that reaches it and holds that
request until it is ready, rather than the CLI polling capability state itself. A request that
arrives while Storage is `stopping` after an idle stop waits for cleanup and then wakes it the same
way. A manually stopped capability keeps wake-up disabled until the stack starts again. These
states are observed directly by Storage operations, including `stack start`.

**`stack start` seeds on first configured start.** When a `stack start` (or the top-level `start`
under the flag) invocation runs the stack's first configured start, including after `stack prepare`
— never when it resumes an existing one — and
Storage is not `disabled`, it seeds `[storage.buckets]` against the stack before printing status,
reusing the `seed buckets` core. A project with no `[storage.buckets]` or
`[storage.vector.buckets]` configured resolves no credentials and prints nothing. Auto-confirm is
safe here since a first-start stack has no pre-existing buckets. Any other unusable Storage state,
a missing capability/endpoint, a gateway activation failure, or an invalid bucket entry fails the
`start` command; startup does not silently skip the configured seed. See
[`stack/start/SIDE_EFFECTS.md`](../src/commands/experimental/stack/start/SIDE_EFFECTS.md).

**`db reset --local` and declarative reset** reapply the catalog, migrations, and seeds before
resuming the saved composition. Bucket-seeding failures warn after the database reset succeeds.
See [`db/reset/SIDE_EFFECTS.md`](../src/commands/db/reset/SIDE_EFFECTS.md).
