# `supabase stack start`

The command is available only when the `experimental.stack` feature flag is enabled. The
top-level `supabase start` command uses this handler when the same flag is enabled.

This command creates or resumes the managed stack identified by the current
project and optional `--stack`, or opens an existing stack with `--stack-id`.
It loads `supabase/config.toml` for the target project when present and uses
default settings when it is absent; starting the stack does not create a config
file. It resolves explicit
`env(NAME)` references plus supported automatic `SUPABASE_*` overrides. Shell
values take precedence over values from `supabase/` dotenv files, which take
precedence over project-root dotenv files. Empty automatic overrides are
ignored. Explicit `env(NAME)` references remain available for values that are
not directly overridden.
The `@supabase/stack` Effect API owns persistent state, the detached
Supervisor, runtime resources, readiness, and cleanup. The CLI only resolves
the project configuration and renders the resulting status.

Durable stack state lives under `$SUPABASE_HOME/managed/stacks/<stackId>/`
(`~/.supabase/managed/stacks/<stackId>/` by default). Ephemeral shadows use
`$SUPABASE_HOME/managed/ephemeral-postgres/<identity>/`.

`SUPABASE_HOME` controls the package's durable stack state through its normal
runtime composition boundary. The stack owner is deliberately detached from
the command waiter, so returning from a successful start leaves the stack
running for later commands. An interrupted start is handled by the package's
owner cleanup contract.

The config loader reads the project environment files used for config
resolution, including the shared `supabase/.env` and `supabase/.env.local`
files when applicable. Function environment settings additionally read the
shared `supabase/functions/.env` and each enabled function's
`supabase/functions/<name>/.env`; per-function values override shared values.
Encrypted values use dotenvx decryption with keys from `DOTENV_PRIVATE_KEY`
and `DOTENV_PRIVATE_KEY_*`; each variable may contain comma-separated keys.
Failed decryption returns a typed configuration error without logging the
plaintext, ciphertext, or private key. Listener port numbers remain dynamically
allocated unless explicitly configured or supplied through a supported
`SUPABASE_*_PORT` override.
The CLI resolves supported environment overrides into a complete plain config
document and validates that effective document with `@supabase/config` before
projecting it into the stack runtime shape. Package validation errors are
reported with field paths and generic values so secrets are not exposed. The
stack projection then wraps consumed secrets, decrypts values at capability
boundaries, and preserves `env(NAME)` function references until runtime settings
are assembled. Provider secrets are resolved when the Auth capability is enabled;
disabled capabilities skip their unconsumed secrets. JWT issuer and signing
overrides are always applied because stack security consumes them even when Auth
itself is disabled. The CLI preserves optional-section presence metadata while
projecting the validated document.

Text output includes the stack id, lifecycle, endpoints, and dormant
capabilities. Structured output includes the same status fields. The command reads configured
credentials and function/provider secrets to pass them to the stack runtime, but
never emits those values.

`--stack` and `--stack-id` are mutually exclusive. For a new stack, `--runtime auto`
selects Docker when the daemon is reachable and native otherwise; a present Docker
client with a dead daemon persists native and prints a notice that destroy-and-recreate
(or a new `--stack` name) is required to use Docker later. Existing stacks reuse their
persisted runtime. `docker` and `native` select the requested runtime without fallback.
Native start is refused as uid 0 because `initdb` refuses root.
`--preparation` controls background versus
on-demand artifact preparation, and `--eager` requests enabled capabilities be
activated before the command returns. Eager capabilities do not receive automatic
idle stops. Per-capability `idleTimeoutSeconds` values are available through the
package's Effect API only; the CLI does not expose them as command or project
configuration settings.
`--exclude` accepts repeated or comma-separated capability names (`rest`, `auth`, `realtime`,
`storage`, `functions`, `studio`, `mail`, `analytics`, and `pooler`) and disables those services
in the effective start configuration. The database cannot be excluded. Exclusions are applied in
memory and persisted with the stack state; the project configuration file is unchanged. A capability
and its dependents are disabled together, so excluding `rest` also disables `studio`. Excluding
`analytics` does not. Analytics and pooler catalog downloads follow the excluded start config;
the platform trio still fail-closes against the full enabled config.
Listeners are derived by the runtime from enabled capability routes; route-less listeners are therefore omitted.
Eager activation never re-enables an excluded capability.
When an addressed stack is already running, `--eager` or a service policy change is rejected;
use `supabase stack restart` to apply the requested policy through the package lifecycle.

The command owns only the start request. Once the package reports readiness,
the detached stack owner remains alive after the CLI process exits. If the CLI
caller is interrupted while waiting, the package's owner lifecycle decides
whether the start can complete or must clean up; the CLI does not call stop or
destroy as a cancellation handler.

Database `network_restrictions`, `ssl_enforcement`, and `vault` settings are
accepted by the project config model but are not implemented by the local
runtime and are not forwarded. They do not enforce database security for this
command.

## Bucket seeding on stack creation

When this invocation runs the stack's first configured start (`desiredLifecycle` was
`unconfigured`, including after `stack prepare`) and Storage is not `disabled`, the
command seeds `[storage.buckets]` — creating or updating buckets and uploading their
`objects_path` files, non-interactively with auto-confirm — against the stack's gateway
using its service-role JWT, before printing the resulting status. Auto-confirm is safe
here because a first-start stack has no pre-existing buckets to overwrite or prune. This
reuses the same seeding core as `supabase seed buckets` and `db reset --local`. Files
read: `supabase/config.toml` `[storage.buckets]`, the configured `objects_path` files,
and the project dotenv files used for config resolution. Network calls:
`POST`/`GET /storage/v1/bucket` and `POST /storage/v1/object/...` against the stack's
API URL.

A project with no `[storage.buckets]` or `[storage.vector.buckets]` configured resolves
no credentials and prints nothing — there is nothing to seed.

A resumed stack is never re-seeded by `start`. Storage `disabled` skips seeding
silently; any other unusable capability state, a missing capability/credentials, or a
stack-gateway activation failure prints a stderr warning and skips seeding without
failing the command. Any other seeding failure (e.g. an invalid bucket entry) fails the
command with exit code `1`, but the stack itself is left running — a seeding failure
never stops or destroys it.

Telemetry state is flushed to `<SUPABASE_HOME or ~/.supabase>/telemetry.json`
after both successful and failed command runs.
