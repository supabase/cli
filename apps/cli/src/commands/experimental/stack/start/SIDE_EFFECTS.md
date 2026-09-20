# `supabase stack start`

The experimental stack family and the enabled top-level `supabase start` alias use this handler.
It creates or resumes the stack for the project and optional `--stack` name, or opens the selected
`--stack-id`. Those selectors are mutually exclusive. Starting does not create a project config file.

## Configuration and state

The CLI loads the target project's `supabase/config.toml`, supported environment overrides, and
project dotenv files. It validates the supported configuration before creating service definitions.
Secrets needed by enabled services are passed to the runtime. State and service data live under
`$SUPABASE_HOME/stacks/<stack-id>/` (`~/.supabase/stacks/<stack-id>/` by default); native artifacts
use `$SUPABASE_HOME/cache/stack`. Storage files use the caller-owned project directory
`supabase/.temp/stack-uploads/<stack-id>/`. Functions preparation may build the project's source.

For a new stack, `--runtime auto` selects native on Linux x64/arm64 and macOS arm64, and Docker
elsewhere. An existing stack keeps its saved runtime. Explicit runtime selection has no fallback.
Native startup refuses root because PostgreSQL `initdb` cannot run as root.

Database is eager by default. Other services are lazy; traffic wakes them through their listeners.
Lazy services with idle policies stop after 60 seconds without traffic; Functions has no automatic
idle stop. `--eager` makes all selected services eager. Changing activation policy can stop and
restart the composition, including when a later invocation omits an earlier `--eager` flag.
`--preparation` selects on-demand or background artifact preparation.

When Functions is selected, the CLI reads and validates `supabase/functions/.env`, ignoring reserved
`SUPABASE_*` entries. If custom env values or default JWT verification differ from the saved member,
start restarts Functions in place before ordinary composition start. A stopped member briefly launches
and stops again so normal lazy activation is retained; its identity and endpoints stay unchanged.

## Service selection

`--exclude` accepts repeated or comma-separated capability names: `rest`, `auth`, `realtime`,
`storage`, `functions`, `studio`, `mail`, `analytics`, and `pooler`. Database cannot be excluded.
Storage includes its Imgproxy companion, Studio includes Pgmeta, and Analytics includes Vector.
Studio requires REST; excluding REST while keeping Studio fails before stopping the composition.

Changing exclusions stops the composition and reuses the existing service identities, data, and
ports. Removed services remain saved and stopped so including them again can reuse them. The
project configuration file is unchanged. Incompatible version, endpoint, or supported configuration
changes fail before stopping existing services; they are not silently applied to saved instances.

## First startup and retries

The first configured startup prepares the database catalog, temporarily runs configured schema-owning
services, applies the database overlay, and runs project migrations and seeds. Membership changes
apply needed catalog and webhook setup without replaying project migrations or seeds. An unchanged
composition reapplies the webhook setting before activation.

When configured, initial Storage bucket seeding creates buckets and uploads their `objects_path`
files using the service-role JWT. Storage is started and made ready before those requests. A resumed
stack is not re-seeded. Projects without configured buckets make no bucket-seeding requests.

A failure or interruption during the first startup stops and unconfigures that initial composition,
then destroys only the service instances created by this invocation. Cleanup diagnostics name any
instance that could not be removed. Existing instances and their data are retained. After successful
cleanup, fixing the cause and retrying starts from an empty composition. Failed resumes do not
destroy existing data. Abrupt process termination that bypasses finalizers requires manual inspection
and, for an incomplete first bootstrap, destruction before retrying; there is no recovery journal.

## Processes, network, and output

The package's detached owner manages service processes, listeners, readiness, and runtime resources.
It remains available after the CLI exits. Preparation downloads native artifacts or pulls container
images. Catalog setup and project SQL connect to the primary database. Bucket seeding uses the local
Storage HTTP endpoint. The CLI does not remove caller-owned Storage files during cleanup.

Text output reports progress and `Stack is ready.`. JSON output returns the stack `id` and an empty
message; use `stack status` for endpoints and service observations. Failures retain typed command
errors and package diagnostics. Telemetry state is flushed after success or failure.
