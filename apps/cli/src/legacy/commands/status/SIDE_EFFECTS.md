# `supabase status`

TS-only divergence (CLI-2167 follow-up, no Go counterpart): `status` additionally resolves and
surfaces the current linked project/branch — a "Linked Project:" block on stdout in human text
mode, and additive fields in every machine-readable output — so an agent (or a human who forgot
which branch they linked) can discover which project/branch it's on without a separate
`link`/`branches` call. See `legacy/shared/legacy-linked-state.ts`.

## Files Read

| Path                                                                                                                | Format     | When                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/config.toml`                                                                                    | TOML       | always, to resolve project configuration                                                                                 |
| `auth.signing_keys_path` (config-relative or absolute)                                                              | JSON       | only when `auth.signing_keys_path` is set in config.toml                                                                 |
| `api.tls.cert_path` / `api.tls.key_path` (unconditionally joined with `<workdir>/supabase`, no absolute-path guard) | raw bytes  | only when `api.enabled` and `api.tls.enabled`, and the respective path is set                                            |
| `<workdir>/supabase/.temp/project-ref`                                                                              | plain text | always (soft) — the linked-state "currently linked ref" lookup (CLI-2167 follow-up, TS-only)                             |
| `<workdir>/supabase/.temp/linked-project.json`                                                                      | JSON       | always (soft), once linked — determines plain-project-vs-branch state and the display name (CLI-2167 follow-up, TS-only) |

## Files Written

| Path                         | Format | When   |
| ---------------------------- | ------ | ------ |
| `~/.supabase/telemetry.json` | JSON   | always |

## API Routes

| Method | Path                             | Auth         | Request body | Response (used fields)                                     |
| ------ | -------------------------------- | ------------ | ------------ | ---------------------------------------------------------- |
| `GET`  | `/v1/projects/{parent}/branches` | Bearer token | none         | `[{name, project_ref, ...}]` (CLI-2167 follow-up, TS-only) |

Everything else is resolved from local `config.toml` and the local Docker daemon — `status` never
required a Management API call before CLI-2167's linked-state follow-up, and still doesn't need
one to succeed. The one route above is part of the shared, best-effort `legacyResolveLinkedState`
helper: it fires ONLY when `linked-project.json` names a genuinely different parent than the
currently linked ref — with no cache at all, the plain project shape renders with zero API calls
(there is no ref-only env/file fallback query anymore — PR #6168 review). When the linked ref came
from `SUPABASE_PROJECT_ID` (env) rather than the `project-ref` file, the route still fires the
same way, but a no-match/failure/timeout result degrades all the way to the plain shape instead of
keeping the cache's parent claim — see `legacyResolveLinkedState`'s doc comment.

The Management API client is acquired LAZILY: `status`'s runtime layer wires up
`LegacyPlatformApiFactory` (not the eager `LegacyPlatformApi`), which resolves NO access token and
makes NO network call at layer-build time — token resolution and client construction only happen
inside `legacyResolveLinkedState`, exactly when this route is about to be called, via
`factory.make`. Any failure there (no token, invalid token, keyring/file miss, network, decode) is
caught and degrades the linked-state display rather than failing `status` — see the Exit Codes
callout below. This is deliberately NOT the eager `legacyManagementApiRuntimeLayer` stack, which
resolves a token at layer-build time and would break every offline/token-less `status` run.

## Environment Variables

| Variable                         | Purpose                                                                                                                                                                                | Required?                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `SUPABASE_PROJECT_ID`            | overrides the resolved local project id; ALSO the 1st candidate for the linked-state "currently linked ref" (CLI-2167 follow-up, TS-only — a shared env var, two independent purposes) | no (falls back to config.toml `project_id` → workdir basename)                                             |
| `SUPABASE_WORKDIR`               | overrides the resolved project workdir                                                                                                                                                 | no (falls back to `--workdir` → walk-up search for `config.toml` → cwd)                                    |
| `SUPABASE_SERVICES_HOSTNAME`     | overrides the hostname used to build local service URLs                                                                                                                                | no (falls back to `DOCKER_HOST`'s tcp host → `127.0.0.1`)                                                  |
| `SUPABASE_AUTH_JWT_SECRET`       | overrides `auth.jwt_secret`                                                                                                                                                            | no                                                                                                         |
| `SUPABASE_AUTH_PUBLISHABLE_KEY`  | overrides `auth.publishable_key`                                                                                                                                                       | no                                                                                                         |
| `SUPABASE_AUTH_SECRET_KEY`       | overrides `auth.secret_key`                                                                                                                                                            | no                                                                                                         |
| `SUPABASE_AUTH_ANON_KEY`         | overrides `auth.anon_key`                                                                                                                                                              | no                                                                                                         |
| `SUPABASE_AUTH_SERVICE_ROLE_KEY` | overrides `auth.service_role_key`                                                                                                                                                      | no                                                                                                         |
| `SUPABASE_ACCESS_TOKEN`          | Management API bearer auth for the LAZY branch-name lookup only (CLI-2167 follow-up, TS-only) — never required for `status` to succeed                                                 | no (falls back to keyring → `~/.supabase/access-token`; absent → the lookup degrades, `status` still runs) |

The `SUPABASE_AUTH_*` vars follow the same `SUPABASE_`-prefixed, `.`→`_` env-var naming
convention used elsewhere in config loading, and take precedence over the corresponding
`config.toml` value.

`docker` (or `podman` as a fallback) must be on `PATH`.

## Exit Codes

| Code | Condition                                                                                                                                                                                                                                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success — status displayed                                                                                                                                                                                                                                                                                                                                      |
| `0`  | **`--ignore-health-check` is set** — skips the health assertion below entirely, so an unhealthy/not-running db never fails the command                                                                                                                                                                                                                          |
| `1`  | `supabase/config.toml` missing or malformed                                                                                                                                                                                                                                                                                                                     |
| `1`  | malformed CSV in an `--override-name`/`--exclude` value — fails during flag parsing, before the handler and telemetry, with the exact diagnostic text on stderr (e.g. `invalid argument "\"api.url=FOO" for "--override-name" flag: parse error on line 1, column 13: extraneous or missing " in quoted-field`; a blank-only value fails with `EOF`) — CLI-2005 |
| `1`  | a malformed `--override-name` entry                                                                                                                                                                                                                                                                                                                             |
| `1`  | listing running containers failed (Docker daemon unreachable, etc.)                                                                                                                                                                                                                                                                                             |
| `1`  | the db container inspect call failed (including "not found") — health assertion, skipped by `--ignore-health-check` above                                                                                                                                                                                                                                       |
| `1`  | the db container is present but not in the `running` state — health assertion, skipped by `--ignore-health-check` above                                                                                                                                                                                                                                         |
| `1`  | the db container is running but its Docker health check isn't `healthy` — health assertion, skipped by `--ignore-health-check` above                                                                                                                                                                                                                            |
| `1`  | `auth.jwt_secret` is configured but shorter than 16 characters (rejected at config-load time)                                                                                                                                                                                                                                                                   |
| `1`  | `auth.signing_keys_path` is configured but the file is missing/malformed, or its first key's algorithm is not `RS256`/`ES256`                                                                                                                                                                                                                                   |
| `1`  | `api.enabled` and `api.tls.enabled` are true and only one of `api.tls.cert_path`/`key_path` is set (rejected at config-load time)                                                                                                                                                                                                                               |
| `1`  | `api.enabled` and `api.tls.enabled` are true, both `cert_path` and `key_path` are set, but one of the files can't be read                                                                                                                                                                                                                                       |

> The linked-state resolution (CLI-2167 follow-up, TS-only) never affects the exit code or any of
> the failure conditions above — it never fails (see `legacyResolveLinkedState`'s doc comment),
> and every one of `status`'s existing failure paths (workdir, config, Docker/health) is untouched.
> If `status` fails, it fails exactly as it did before this feature existed; in human text mode the
> "Linked Project:" block has already been printed to stdout before that failure occurs, and in
> `--output-format json`/`stream-json` the same linked-state fields are carried on the failure
> envelope itself (see Output below). This holds even when the lazy Management API acquisition
> itself fails (no token, invalid token, network, decode) — that failure is caught inside
> `legacyResolveLinkedState` and only degrades the block's/envelope's content, never `status`'s own
> exit code.

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

## Output

### `--output-format text`

TS-only addition (CLI-2167 follow-up, no Go counterpart; Neon-style block per Colum's request):
before any of the Go-compatible output below, and before any daemon/stack work begins, a block
goes to **stdout** — so it's still visible even if `status` subsequently fails to connect to
Docker. Only in human text mode (`-o` unset or `-o pretty` AND `--output-format text`); a spinner
(`Checking linked branch...`) may show first if resolving the linked branch's name needs a
best-effort API lookup.

- Not linked (single line, unchanged shape from before this block format):
  ```
  Not linked.
  ```
- Linked, header + up to 3 indented lines — `Org:` only when `linked-project.json` carries at
  least one of `organization_slug`/`organization_id`; `Project:` always; `Branch:` only in the
  branch-linked state (a genuinely different, confirmed-or-attempted parent):
  ```
  Linked Project:
    Org: <org_slug> (<org_id>)
    Project: <project_name> (<parent_or_project_ref>)
    Branch: <branch_name> (<branch_ref>)
  ```
  - `Org:` renders `<slug> (<id>)` when both are known and differ, the single value with no
    parentheses when both are known and equal (or only one is known), and is omitted when neither
    is known.
  - `Project:` shows the PARENT's name+ref in the branch-linked state, or the linked project's own
    name+ref otherwise; a bare ref (no parentheses) when the name isn't known.
  - `Branch:` shows the resolved name+ref when the best-effort lookup found a match, or a bare ref
    when it didn't (unresolved/degraded) — the user must still see they're on a branch even when
    the lookup can't run (no token, offline, API error, 5s timeout): this is the fix for the bug
    this whole block format shipped to fix (a prior release's degraded state silently looked
    identical to a plain project link).
  - When `linked-project.json` is absent entirely, the block always renders the plain
    `Project: <bare linked ref>` line (no `Org:`, no `Branch:`) with ZERO API calls — there is no
    fallback lookup against the env/file chain anymore (PR #6168 review).
  - When the linked ref came from `SUPABASE_PROJECT_ID` (env) rather than the `project-ref` file,
    and a cache exists but names a DIFFERENT project than the env override, the branch lookup still
    runs, but a `Branch:` line (and the cache's `Org:`/parent name) only appears when that lookup
    POSITIVELY confirms the override is a branch of the cached project — otherwise the block
    degrades all the way to the plain bare-ref line above, never asserting a parent relationship on
    nothing but the cache's mere presence (PR #6168 review).

Default (`-o` unset or `-o pretty`): a stderr banner, then 5 grouped rounded-border tables on
stdout. Empty rows (a value with nothing resolved) and entirely empty groups are skipped; a
blank line follows every group, rendered or not.

```
supabase local development setup is running.

╭──────────────────────────────────────╮
│ 🔧 Development Tools                 │
├─────────┬────────────────────────────┤
│ Studio  │ http://127.0.0.1:54323     │
│ Mailpit │ http://127.0.0.1:54324     │
│ MCP     │ http://127.0.0.1:54321/mcp │
╰─────────┴────────────────────────────╯

╭──────────────────────────────────────────────────────╮
│ 🌐 APIs                                              │
├────────────────┬─────────────────────────────────────┤
│ Project URL    │ http://127.0.0.1:54321              │
│ REST           │ http://127.0.0.1:54321/rest/v1      │
│ GraphQL        │ http://127.0.0.1:54321/graphql/v1   │
│ Edge Functions │ http://127.0.0.1:54321/functions/v1 │
╰────────────────┴─────────────────────────────────────╯

╭───────────────────────────────────────────────────────────────╮
│ ⛁ Database                                                    │
├─────┬─────────────────────────────────────────────────────────┤
│ URL │ postgresql://postgres:postgres@127.0.0.1:54322/postgres │
╰─────┴─────────────────────────────────────────────────────────╯

╭──────────────────────────────────────────────────────────────╮
│ 🔑 Authentication Keys                                       │
├─────────────┬────────────────────────────────────────────────┤
│ Publishable │ sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH │
│ Secret      │ sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz      │
╰─────────────┴────────────────────────────────────────────────╯

╭───────────────────────────────────────────────────────────────────────────────╮
│ 📦 Storage (S3)                                                               │
├────────────┬──────────────────────────────────────────────────────────────────┤
│ URL        │ http://127.0.0.1:54321/storage/v1/s3                             │
│ Access Key │ 625729a08b95bf1b7ff351a663f3a23c                                 │
│ Secret Key │ 850181e4652dd023b7a98c58ae0d2d34bd487ee0cc3254aed6eda37307425907 │
│ Region     │ local                                                            │
╰────────────┴──────────────────────────────────────────────────────────────────╯
```

Group table cells are colored on a TTY (Aqua for links, Yellow for keys, Green for labels, bold
headers); colors are stripped on non-TTY/piped output.

`Stopped services: [<container-id> ...]` is written to stderr (space-separated
bracketed list, e.g. `[supabase_storage_test supabase_studio_test]`) whenever one of
the 13 expected service containers isn't in the running set.

### `-o env`

`KEY="VALUE"` lines (unquoted for integer-looking values), one per resolved field, sorted by
key — see `legacy-go-output.encoders.ts`'s `encodeEnv`.

TS-only addition (CLI-2167 follow-up, no Go counterpart): additive `LINKED_PROJECT_REF`,
`LINKED_PROJECT_NAME`, `LINKED_ORG_SLUG`, `LINKED_ORG_ID`, `LINKED_BRANCH`,
`LINKED_PARENT_PROJECT_REF` lines — only the ones known (sorted in with everything else, since
`encodeEnv` sorts every key). Entirely absent when not linked — there is no `LINKED=false` line.
In the branch-linked state, a degraded/unresolved lookup still emits every field the cache knows
(`LINKED_PROJECT_REF`, `LINKED_PARENT_PROJECT_REF`, `LINKED_PROJECT_NAME`, the org fields) — only
`LINKED_BRANCH` is absent.

### `-o json`

```json
{
  "API_URL": "http://127.0.0.1:54321",
  "DB_URL": "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  "ANON_KEY": "...",
  "SERVICE_ROLE_KEY": "...",
  "PUBLISHABLE_KEY": "...",
  "SECRET_KEY": "...",
  "JWT_SECRET": "...",
  "S3_PROTOCOL_ACCESS_KEY_ID": "625729a08b95bf1b7ff351a663f3a23c",
  "S3_PROTOCOL_ACCESS_KEY_SECRET": "...",
  "S3_PROTOCOL_REGION": "local",
  "linked_branch": "feature-branch",
  "linked_org_id": "org_1",
  "linked_org_slug": "acme",
  "linked_parent_project_ref": "abcdefghijklmnopqrst",
  "linked_project_name": "My Project",
  "linked_project_ref": "wenchaxrhtjkzqzxctxr"
}
```

Top-level keys sorted alphabetically, 2-space indent, trailing newline. Fields whose owning
service is disabled or excluded are omitted entirely (not emitted as `null`/`""`).

TS-only addition (CLI-2167 follow-up, no Go counterpart): additive `linked_project_ref`,
`linked_project_name`, `linked_org_slug`, `linked_org_id`, `linked_branch`,
`linked_parent_project_ref` keys — only the ones known (the JSON encoder alphabetizes every key
regardless of insertion order, so they sort in among the existing fields, as in the branch-linked
sample above). Entirely absent when not linked. Degraded branch-linked state (see the text-mode
callout above) emits every key it knows — only `linked_branch` is ever absent on its own.

### `-o yaml` / `-o toml`

Same value set as `-o json` (including the additive `linked_*` keys above when linked), encoded
via `encodeYaml`/`encodeToml`. Unlike `-o json`/`-o env`, these two encoders preserve insertion
order rather than sorting — the `linked_*` keys are merged in AFTER every existing key, so they
render last.

### `--output-format json` / `stream-json` (when `-o` is unset or `pretty`)

Additive — no Go CLI equivalent. Emits the same resolved value map via
`output.success("", values)` / the NDJSON `result` event, plus one more additive, nested field
(CLI-2167 follow-up, TS-only): `linked_project`, `null` when not linked, otherwise
`{ project_ref, branch?, parent_project_ref?, project_name?, org_slug?, org_id? }` — e.g. for the
branch-linked state:

```json
{
  "linked_project": {
    "project_ref": "wenchaxrhtjkzqzxctxr",
    "branch": "feature-branch",
    "parent_project_ref": "abcdefghijklmnopqrst",
    "project_name": "My Project",
    "org_slug": "acme",
    "org_id": "org_1"
  }
}
```

A degraded/unresolved branch-linked lookup emits the same object minus `branch` only — every
other field the cache knows is still present, matching the machine-format guarantee above.

`--override-name` CAN rename one of the 18 known fields to literally `linked_project` (or, for
`-o env|json|toml|yaml`, to one of the `linked_*` keys below) — the existing/overridden `values`
key always wins that collision, never this extension (PR #6168 review; see `valuesWithLinkedState`
and the structured-payload `output.success` call in `status.handler.ts`).

**The same `linked_project` object is carried on the FAILURE envelope too** (CLI-2167 follow-up,
TS-only) — the agent-discovery use case matters most when `status` fails to reach the
daemon/stack, since a stopped stack is the common state an agent probes `status` in:

```json
{
  "_tag": "Error",
  "error": { "code": "LegacyStatusDbInspectError", "message": "..." },
  "linked_project": {
    "project_ref": "wenchaxrhtjkzqzxctxr",
    "branch": "feature-branch",
    "parent_project_ref": "abcdefghijklmnopqrst",
    "project_name": "My Project",
    "org_slug": "acme",
    "org_id": "org_1"
  }
}
```

`null` when not linked, same degraded-field guarantee as the success payload otherwise. The
`stream-json` terminal `error` event gains the same top-level `linked_project` field alongside
`type`/`error`/`timestamp`. This is carried by `shared/output/machine-error-context.service.ts`'s
`MachineErrorContext` — a command-scoped, opt-in cell that `jsonOutputLayer`/`streamJsonOutputLayer`'s
`fail` read via `Effect.serviceOption` (so any command can adopt it; only `status` does today) and
spread onto the envelope's top level, never inside `error`. `status`'s handler sets it (also via
`Effect.serviceOption`, so this stays a no-op wherever the layer isn't wired) right after resolving
the linked state, before any daemon/stack work, mirroring the same `legacyLinkedStateJsonField`
value the success path already uses.

**`-o env|json|yaml|toml`'s failure output is intentionally UNCHANGED** — those Go-compatible
formats still print nothing but the red stderr message on failure (no payload at all), matching
the Go CLI's own contract exactly. The additive failure envelope above is scoped to
`--output-format json`/`stream-json` (the agent-facing modes) only.

## Notes

- The linked-state feature (CLI-2167 follow-up) resolves in EVERY output mode, not just human
  text — the intent is that an AI agent driving `status` in a machine format can discover which
  project/branch it's on without a separate `link`/`branches` call. The resolution
  (`legacyResolveLinkedState`) never fails: not linked, a missing/unreadable cache file, no
  resolvable parent, no Management API service in scope, an offline/token-less
  `LegacyPlatformApiFactory` acquisition failure, or a failed/empty branch lookup all degrade
  rather than erroring, so this feature can never be the reason `status` fails or its exit code
  changes. `legacyAcquireLinkedStateApi` (in `legacy-linked-state.ts`) tries
  `Effect.serviceOption(LegacyPlatformApi)` first (the cheapest path, and what tests provide
  directly), then falls back to `Effect.serviceOption(LegacyPlatformApiFactory)` → `factory.make`
  with every failure caught — `status`'s runtime layer only ever wires up the lazy factory (see
  API Routes above), never the eager client. The branch-name lookup (acquisition + the
  `listAllBranches` call together) is hard-bounded to 5 seconds (`Effect.timeout`, PR #6168
  review) — this is decoration on an interactive command, and the generated client's own retry
  policy would otherwise let a single blackholed API stall every `status` run for minutes; a
  timeout degrades exactly like any other lookup failure.
- The linked ref itself (env `SUPABASE_PROJECT_ID` or the `project-ref` file) is VALIDATED
  against `PROJECT_REF_PATTERN` before use: malformed or symlinked non-ref content (e.g. a
  `project-ref` symlinked at an access token) is treated as not linked and never reaches ANY
  output channel — machine formats included (PR #6168 review). The cache-sourced display fields
  (name, org slug/id) remain merely sanitized (`legacySanitizeInlineName`), as are all strings in
  the human-text block, so a hostile name cannot inject ANSI/OSC/newline controls into stdout;
  machine payloads stay data-faithful for those fields since JSON/YAML/TOML/env encoding already
  neutralizes control characters.
- `-o`/`--output` (`env|pretty|json|toml|yaml`) takes priority over `--output-format` whenever
  it is set. `-o pretty` (or `-o`
  unset) falls through to `--output-format`'s text/json/stream-json handling.
- `--override-name api.url=NEXT_PUBLIC_SUPABASE_URL` remaps a single field's output KEY; the
  value and group layout are unaffected. An unknown key or a malformed (non `KEY=VALUE`) entry
  fails with `LegacyStatusOverrideParseError`. This only affects the `env`/`json`/`toml`/`yaml`
  (`printStatus`) output path — the pretty table (`-o pretty` or unset) always
  renders with un-overridden names.
  An override that renames a field to collide with one of the additive `linked_*`/`linked_project`
  keys never loses to this extension — see the `-o json`/`--output-format json` callouts above
  (PR #6168 review).
- When neither `docker` nor `podman` can be spawned at all, the error message names the actual
  root cause (e.g. "docker: command not found (podman also not found) — install Docker Desktop or
  Podman and ensure it is on PATH") rather than a generic "failed to ..." string.
- `--exclude <value>` (hidden) omits a service from the value map when `value` matches either its
  container id or its default Docker image short name (e.g.
  `storage-api` for the storage service, `edge-runtime` for edge functions) — the default image
  is read from the same embedded Dockerfile manifest the old Go CLI parsed, so a version bump
  there is picked up automatically without needing to read the `.temp/<service>-version` pin file.
- `--ignore-health-check` (hidden) skips the db container health assertion entirely and always
  exits `0`.
- Default `auth.anon_key`/`auth.service_role_key`/`auth.jwt_secret` values are generated via a
  Go-byte-exact HS256 signer (`legacy-go-jwt.ts`), not `@supabase/stack`'s `generateJwt` — the
  latter uses a different issuer, expiry, and claim order that would not match the old Go CLI's
  local dev keys. A configured `auth.jwt_secret` shorter than 16 characters fails the command
  (`LegacyStatusInvalidConfigError`) at config-load time before any command can render output.
- When `auth.signing_keys_path` is set and resolves to a non-empty JWK array, `anon_key`/
  `service_role_key` are instead signed asymmetrically (RS256/ES256) with the file's first key —
  a relative path resolves against
  `<workdir>/supabase`. This path is skipped entirely when `auth.anon_key`/`auth.service_role_key`
  are explicitly configured. A missing/malformed file, or a first key with an algorithm other than
  `RS256`/`ES256`, fails the command (`LegacyStatusInvalidConfigError`).
- `SUPABASE_AUTH_JWT_SECRET`/`SUPABASE_AUTH_PUBLISHABLE_KEY`/`SUPABASE_AUTH_SECRET_KEY`/
  `SUPABASE_AUTH_ANON_KEY`/`SUPABASE_AUTH_SERVICE_ROLE_KEY` override the corresponding
  `config.toml` value at higher precedence — an empty env var
  is treated as unset. This is scoped to exactly the 5 auth fields `status` reads; it is not a
  general `@supabase/config` port of Viper's `AutomaticEnv` (which applies to every config field).
- `db.password` and the `storage.s3_credentials` triple have no `@supabase/config` schema field;
  the old Go CLI hardcoded both (`"postgres"` and the S3 access key/secret/region seen above),
  reproduced identically in `legacy-local-config-values.ts`.
- No e2e test is planned for this command: there is no Docker-daemon-free golden path, and the
  e2e harness (`runSupabase()`) does not provision a real local stack. This is a scope reduction
  relative to the Linear issue's "E2E compatibility test added" checkbox; see the port plan for
  the full justification.
