# `supabase stack start`

The experimental stack family and the enabled top-level `supabase start` alias use this handler.
It creates or resumes the stack for the project and optional `--stack` name, or opens the selected
`--stack-id`. Those selectors are mutually exclusive. Starting does not create a project config file.

## Configuration and state

For a new stack or a stopped existing stack, the CLI loads the target project's
`supabase/config.toml`, supported environment overrides, and project dotenv files. It validates the
supported configuration before creating service definitions. When every member of the existing
composition is running and healthy, or armed to wake and not already starting, start reports its
current endpoints and returns without reading or applying project configuration. When the database
is running and every other member is running with any health, starting, or armed to wake, start
notes that configuration changes apply after stop and start, starts the saved composition, and waits
until every member that was running or starting is ready, again without reading project
configuration.

If the stack is otherwise in a partial lifecycle state, start fails with guidance to stop the stack
and start it again before applying configuration.
Auth policies, OAuth providers, hooks, MFA, SMTP, email subjects and notification controls are
forwarded to Auth. REST search paths, pooler limits, Realtime settings, Studio settings, Storage
S3 protocol/vector controls are forwarded to their services. Storage receives the local S3 access
keys and region, and uses the gateway's `/storage/v1` prefix to verify S3 signatures and to build
resumable upload URLs. `analytics.vector_port` and `SUPABASE_ANALYTICS_VECTOR_PORT` are accepted
and ignored: the stack runs no Vector service.
Encrypted JWT secrets are decrypted before shared credentials are derived. `db.health_timeout`
controls database readiness; package JWT and PostgreSQL root-key defaults apply when omitted, and
the effective root key is supplied through a stack-owned key file.
Studio receives the database connection, the Functions management directory/URL, and Analytics
credentials when present. Starting with Studio creates `supabase/snippets/`, where Studio saves SQL
snippets.
Email template `content_path` values and third-party identity providers remain unsupported: they
require template serving and shared external JWKS verification respectively.
`db.orioledb_version` (or `SUPABASE_DB_ORIOLEDB_VERSION`) runs the catalog's OrioleDB build of that
version instead of the stock major. Loading fails unless the catalog pins that OrioleDB version and
`db.major_version` matches its major; the error lists the pinned OrioleDB versions. The
`experimental.s3_*` OrioleDB settings are not forwarded, so loading fails when they are set.

Secrets needed by enabled services are passed to the runtime. State and service data live under
`$SUPABASE_HOME/stacks/<stack-id>/` (`~/.supabase/stacks/<stack-id>/` by default); native artifacts
use `$SUPABASE_HOME/cache/stack`. Storage files use the caller-owned project directory
`supabase/.temp/stack-uploads/<stack-id>/`. Functions preparation may build the project's source.
The owner persists each service's output under `$SUPABASE_HOME/stacks/<stack-id>/logs/`, keeping at
most about 10 MiB (plus the segment being written) per service instance. Destroying an instance or
the stack deletes those logs; stopping the stack and resetting database data keep them.
PostgREST runs with `PGRST_LOG_LEVEL=info`, so every request line, query string included, is
persisted and shipped to Analytics.
When an owner starts a stack saved with a Vector instance, it removes that instance, its composition
members, dependencies and port claims from `state.json`, and its stack-owned Vector config files
under `data/<instance-id>/runtime/vector/`; its containers go with the stack's container sweep. A
migration that fails is logged as a warning and retried by the next owner start.

For a new stack, `--runtime auto` selects Docker when `docker version` reaches its daemon, then
Podman when `podman info` reaches its engine, then native on Linux x64/arm64 and macOS arm64. Each
probe is bounded by 10 seconds. Without a reachable engine on other platforms, the command fails and
asks the user to start Docker or Podman. When auto selection skips Docker, an info line names the
saved Podman or native runtime and how to switch to Docker. An existing stack keeps its saved
runtime and runs no probe. Explicit `--runtime docker`, `podman`, or `native` has no fallback.
When an explicit or saved Docker runtime is unreachable, the reported failure suggests starting
Docker, and `--runtime native` for a new stack on platforms that support native. Explicit
`--runtime native` on a platform with no native artifacts fails before creating a stack.

Native startup refuses root because PostgreSQL `initdb` cannot run as root, unless a Claude Code
or Modal Sandbox is detected or `SUPABASE_NATIVE_POSTGRES_USER` names a non-root user. PostgreSQL then runs
as that user: the CLI chowns the instance data, root key, socket directory, and the cached bundle's
`pgsodium_getkey.sh` to it, and adds traverse-only `o+x` to their parent directories, including
root's home directory. Later commands that restrict the artifact cache and stack state roots to
their owner keep that grant.

Database is eager by default. Other services are lazy; traffic wakes them through their listeners.
Lazy services with idle policies stop after 60 seconds without traffic, Studio after 5 minutes. A
service that a running service depends on, such as pg-meta for Studio, stays up until that
dependent stops. Functions has no automatic idle stop. `--eager` makes all selected services eager.
Changes to activation policy take effect after stopping and starting the stack, including when a
later invocation omits an earlier `--eager` flag. `--preparation` selects on-demand or background
artifact preparation.

When Functions is selected, the CLI reads and validates `supabase/functions/.env`, ignoring reserved
`SUPABASE_*` entries. `edge_runtime.secrets` overrides that file, while `functions.<name>.env`
provides per-function values from project environment references. Per-function enabled/JWT policies,
entrypoints, import maps and static files are forwarded to the worker bootstrap. Configured paths
are relative to `supabase/` and must remain within the project; Docker mounts that project read-only.
The inspector port is retained as an endpoint intent and does not enable debugging by itself.
Running start calls do not refresh Functions from changed project files; stop the stack and start
it again to apply those changes.

## Service selection

`--exclude` accepts repeated or comma-separated capability names: `rest`, `auth`, `realtime`,
`storage`, `functions`, `studio`, `mail`, `analytics`, and `pooler`. Database cannot be excluded.
Storage includes its Imgproxy companion and Studio includes Pgmeta.
Studio requires REST; excluding REST while keeping Studio fails before stopping the composition.

## Service logs in Analytics

The owner ships the persisted Auth, REST, Realtime, Storage, Functions, and database output lines
(not launch or lost markers) to Analytics' `POST /api/logs` ingest endpoint on its direct backend,
using the Analytics API key and the legacy Logflare source names (`gotrue.logs.prod`,
`postgREST.logs.prod`, `realtime.logs.prod`, `storage.logs.prod.2`, `deno-relay-logs`,
`postgres.logs`) with the legacy per-service field remaps. This applies to the Docker, Podman, and
native runtimes. Shipping runs only while the composed Analytics service is running and healthy;
each instance keeps its position in `logs/<service>/<instance-id>/cursor.json`, so lines written
while Analytics is stopped, starting, or unhealthy are shipped with their original timestamps once
it is healthy again, including after an owner restart. A missing or unreadable position starts from
the oldest retained line. Lines already deleted by log retention are skipped, and Analytics refusing
the API key pauses shipping until Analytics stops or turns unhealthy and is healthy again, or the
composition selects a different Analytics instance. A failed log read is retried from the saved
position with a backoff. Each event carries an id derived from its instance and position. Before
posting a request, the owner records it as pending in `cursor.json`; it then reads Analytics'
Postgres tables (`_analytics.sources` and `_analytics.log_events_<token>` in the stack's
`_supabase` database) to confirm which events are stored, posts only the missing ones, and
advances the position once all are stored. While those tables cannot be read, shipping waits and
logs one warning. Events an Analytics process accepted are not posted to it again while it may
still store them; events still missing are posted again 5 seconds after the request ended once
Analytics restarted, or 60 seconds after it once the owner restarted, and a pending request is
confirmed the same way. Events still missing after 60 seconds of Analytics serving are posted
again in halves; one that is still not stored on its own is skipped with a warning once Analytics
stored a later request, and kept otherwise. NUL characters and unpaired
surrogates in shipped lines are replaced with U+FFFD. Shipping never wakes Analytics
and does not count as idle activity, so a lazy Analytics still stops on its idle timer while other
services log. Service log streams and `supabase stack logs` are never blocked by shipping.

After an explicit stop, start compares the project configuration with the saved composition through
the stack package's composition plan, ignoring values the composition and stack credentials supply.
Changed service settings, including Functions env values, per-function settings, files root, and JWT
verification, replace the saved configuration of the existing instances; their identities, data,
and ports are retained. Changed exclusions reuse existing service identities, data, and ports.
Removed services remain saved and stopped so including them again can reuse them; a saved stopped
instance of a newly included service is reused when its endpoints and versions still match. The
project configuration file is unchanged. A changed endpoint, artifact version, or PostgreSQL major
version fails before modifying the stopped composition, naming the `config.toml` key or
`SUPABASE_*` env var behind the change with its saved and requested values, and suggesting either
reverting it or running the stack's exact `supabase stack destroy` command to recreate it.
Switching between stock PostgreSQL and OrioleDB is an artifact version change, reported as
`db.orioledb_version` (or `SUPABASE_DB_ORIOLEDB_VERSION`) with `unset` standing for stock.
Initialized database data is reused only on its own release line (major plus stock or OrioleDB). A
first start records the requested line before initializing data, so a first start interrupted
before readiness resumes on that line; unmarked data without a recorded line can prove only its
major, so it is never reused for OrioleDB.

## First startup and retries

The first configured startup prepares the database catalog, temporarily runs configured schema-owning
services, applies the database overlay, and runs project migrations and seeds. Membership changes
apply needed catalog and webhook setup without replaying project migrations or seeds. An unchanged
composition reapplies the webhook setting before activation.

When configured, initial Storage bucket seeding creates buckets and uploads their `objects_path`
files using the service-role JWT, silently overwriting or pruning existing buckets without a
confirmation prompt. Storage is started and made ready before those requests. A resumed
stack is not re-seeded. Projects without configured buckets make no bucket-seeding requests.

A new stack is registered by its owner once that owner starts; if the owner fails to start (for
example, Docker is unavailable) or the launch is interrupted, it removes that registration, and the
CLI reports the single launch failure with no separate stop diagnostic. Any other failure or interruption during the first startup stops and
unconfigures that initial composition, then destroys only the service instances created by this
invocation. When startup began without a running owner, failure cleanup stops any owner launched
during startup and waits for its exit. A target with a running owner keeps it. Existing instances and
their data are retained, and failed resumes do not destroy existing data. Cleanup diagnostics name any
instance that could not be removed or owner that could not be stopped. After successful cleanup,
fixing the cause and retrying starts from an empty composition.
Successful startup leaves the owner available after the CLI exits. Abrupt process termination that
bypasses finalizers requires manual inspection and, for an incomplete first bootstrap, destruction
before retrying; there is no recovery journal.

## Processes, network, and output

The package's detached owner manages service processes, listeners, readiness, and runtime resources.
It remains available after the CLI exits. Preparation downloads native artifacts or pulls container
images. Catalog setup and project SQL connect to the primary database. Bucket seeding uses the local
Storage HTTP endpoint. The CLI does not remove caller-owned Storage files during cleanup.

Text output reports progress and `Stack is ready.`, then prints the connection summary shared with
`stack status` on stdout: API, REST, Functions, Studio, MCP, Mailpit, and database URLs for the
members that expose them, the publishable and secret keys, the Storage S3 URL, access keys, and
region when the S3 protocol is enabled, a services table, the runtime, and a
pointer to `supabase status --env` that repeats an explicit `--workdir` and any `--stack` selector or the resolved full `--stack-id`, shell-quoted. Progress lines
and warnings written while the spinner is shown appear on their own rows.

JSON output returns the stack `id`, its saved `runtime`, `endpoints` keyed by service and endpoint
name (protocol, address, port, and URL, matching `stack status`, with no synthetic entries),
`lazy_services` listing members that start on their first request (empty with `--eager`), `env`
(the same connection map `stack status --env` exports, present on every success path), and an
empty message. See [`docs/stack-commands.md`](../../../../../docs/stack-commands.md) for an
example. Failures retain typed command errors and package diagnostics. Telemetry state is flushed
after success or failure.

A rejected configuration change additionally carries `stack_changes` on the JSON/stream-json error
envelope: one entry per affected service and setting (a shared setting such as the API port appears
once per API-backed service, unlike the deduplicated text message; a database version change that
moves both `db.major_version` and `db.orioledb_version` has an entry for each), each with `service`, `path` (the
composition planner's dotted path, e.g. `endpoints.http.port`, not a `config.toml` key), `key`,
`saved`, `requested`, and `editable`. `recreate_command` is the exact `supabase stack destroy
--stack-id <id>` invocation, without `--yes`, since destroy deletes local database data; running it
non-interactively or with `--output-format json`/`--output-format stream-json` requires passing
`--yes` explicitly.
