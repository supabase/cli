# Service Versioning in the Supabase CLI

How the old Go CLI handled local dev versions, and how the current TypeScript CLI resolves
service versions today.

## Architecture Overview

```text
DEFAULT_VERSIONS
      |
      v
candidate baseline
(linked cache + defaults)
      |
      v
.supabase/stacks/<name>/stack.json
(pinned baseline)
      |
      v
.supabase/local-versions.json
(checkout-local overrides)
      |
      v
supabase start --service-version service=version
      |
      v
runtime versions
      |
      v
@supabase/stack
```

The important separation is:

- `project.json` caches linked remote service versions
- `stack.json` pins what a named local stack should use by default
- `local-versions.json` and `--service-version` override the pinned baseline at runtime

## 1. Source of Truth for CLI Defaults

The old Go CLI used `pkg/config/templates/Dockerfile` as a version manifest so Dependabot could
bump image tags automatically.

The TypeScript stack exports a typed `DEFAULT_VERSIONS` manifest instead. That constant is the
built-in default version set for a given CLI release.

These defaults are the fallback for:

- unlinked projects
- services that are not exposed by the linked project version probes
- new stacks before the user pins anything explicitly

## 2. Legacy Go Override System

The old Go CLI wrote repo-local version files into `.supabase/.temp/` when a project was linked:

```text
.supabase/.temp/
  postgres-version
  gotrue-version
  rest-version
  storage-version
  ...
```

At config load time, those files overrode the compiled defaults.

Go CLI priority order:

1. `.temp/*-version` files written by `supabase link`
2. `config.toml` settings such as `db.major_version`
3. built-in defaults compiled into the binary

The TypeScript CLI does not use repo-local `.temp/*-version` files as its normal runtime source of
truth.

## 3. Current TypeScript CLI State Files

The current TypeScript CLI uses gitignored repo-local state under:

```text
<project-root>/.supabase/
```

`SUPABASE_HOME` is still used for global auth fallback, telemetry, and binary cache, but not for
the primary linked-project record anymore.

### `project.json`

`.supabase/project.json` stores cached linked-remote metadata for the current checkout.

Shape:

```json
{
  "ref": "abcdefghijklmnopqrst",
  "name": "my-project",
  "fetchedAt": "2026-03-25T12:34:56.000Z",
  "versions": {
    "postgres": "17.6.1.084",
    "postgrest": "14.4",
    "auth": "2.188.1",
    "storage": "1.43.3"
  }
}
```

This file is written by `supabase link`, refreshed again by `supabase stack update` when the
project is linked, and removed by `supabase unlink`.

### `stack.json`

`.supabase/stacks/<name>/stack.json` stores the pinned baseline for one named local stack.

Shape:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-03-25T12:40:00.000Z",
  "ports": {
    "apiPort": 54321,
    "dbPort": 54322
  },
  "services": {
    "postgres": "17.6.1.084",
    "postgrest": "14.4",
    "auth": "2.188.1",
    "realtime": "2.34.47",
    "storage": "1.43.3",
    "imgproxy": "v3.8.0",
    "mailpit": "v1.22.3",
    "pgmeta": "0.95.2",
    "studio": "2026.02.16-sha-26c615c",
    "analytics": "1.33.3",
    "vector": "0.28.1-alpine",
    "pooler": "2.7.4"
  }
}
```

This file is:

- created on the first `supabase start` for a new stack
- rewritten by `supabase stack update`
- kept when the stack is stopped normally
- removed by `supabase stop --no-backup`

### `state.json`

`.supabase/stacks/<name>/state.json` is the live runtime record for a running stack.

It contains:

- connection info and service endpoints
- process and socket metadata
- the exact running service versions for that invocation

It is written when the stack is running and removed on normal `supabase stop`.

### `local-versions.json`

`.supabase/local-versions.json` stores optional checkout-local service version overrides.

Shape:

```json
{
  "updatedAt": "2026-03-23T10:15:00.000Z",
  "versions": {
    "auth": "2.180.0",
    "storage": "1.39.2"
  }
}
```

This file is CLI-owned runtime state, not user-authored project config.

## 4. Remote Version Sources Today

The current link flow gets remote version information from these sources:

| Service     | Current source in code           | Route / field                                                        | Notes                                                                                   |
| ----------- | -------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `postgres`  | Management API                   | `GET /v1/projects/{ref}` → `project.database.version`                | This is the only service version currently read directly from the Management API.       |
| `postgrest` | Tenant probe                     | `GET https://{ref}.{projectHost}/rest/v1/` → `info.version`          | Requires a project API key to call the tenant endpoint.                                 |
| `auth`      | Tenant probe                     | `GET https://{ref}.{projectHost}/auth/v1/health` → `version`         | Requires a project API key to call the tenant endpoint.                                 |
| `storage`   | Tenant probe                     | `GET https://{ref}.{projectHost}/storage/v1/version` → response body | Requires a project API key to call the tenant endpoint.                                 |
| `realtime`  | Not exposed in current link flow | none                                                                 | Included in local `DEFAULT_VERSIONS`, but no remote version probe is implemented today. |
| `imgproxy`  | Not exposed in current link flow | none                                                                 | Local/dev-infra service; no hosted parity probe today.                                  |
| `mailpit`   | Not exposed in current link flow | none                                                                 | Local-only dev service; no hosted parity probe today.                                   |
| `pgmeta`    | Not exposed in current link flow | none                                                                 | Included in local `DEFAULT_VERSIONS`, but no remote version probe is implemented today. |
| `studio`    | Not exposed in current link flow | none                                                                 | Included in local `DEFAULT_VERSIONS`, but no remote version probe is implemented today. |
| `analytics` | Not exposed in current link flow | none                                                                 | Included in local `DEFAULT_VERSIONS`, but no remote version probe is implemented today. |
| `vector`    | Not exposed in current link flow | none                                                                 | Local/dev-infra service; no hosted parity probe today.                                  |
| `pooler`    | Not exposed in current link flow | none                                                                 | Included in local `DEFAULT_VERSIONS`, but no remote version probe is implemented today. |

To bootstrap the tenant probes above, the CLI also calls:

| Purpose                                                            | Management API route                                  | Notes                                                                                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Get a tenant API key for `postgrest`, `auth`, and `storage` probes | `GET /v1/projects/{ref}/api-keys` with `reveal: true` | This route does not return service versions itself; it only provides an API key the CLI can use against tenant endpoints. |

So, in the current implementation, the complete Management API route set involved in remote
version discovery is:

- `GET /v1/projects/{ref}`
- `GET /v1/projects/{ref}/api-keys` with `reveal: true`

Only the first route currently returns a service version directly.

## 5. Current Resolution Model

There are two layers of resolution:

### Candidate baseline

The candidate baseline is computed from:

1. cached linked service versions from `.supabase/project.json`
2. `DEFAULT_VERSIONS` for everything else

This baseline answers: "what would we pin if we adopted the currently known linked/default
versions right now?"

### Runtime versions

The actual runtime precedence is:

1. per-run `--service-version`
2. checkout-local versions from `.supabase/local-versions.json`
3. pinned versions from `.supabase/stacks/<name>/stack.json`

So `project.json` does not directly win at startup once a stack has already been pinned. It only
influences:

- the first start of a new stack
- later `supabase stack update` runs
- drift information shown by `supabase stack status`

## 6. Current Command Behavior

### `supabase link`

When a user runs `supabase link`:

1. the CLI resolves or prompts for the linked remote project
2. it fetches the current remote versions it knows how to probe
3. it saves those values to `.supabase/project.json`
4. it warns if any existing pinned `stack.json` records are now behind

`link` does not rewrite pinned stack versions.

### `supabase start`

When a stack has never been started before:

1. the CLI computes the candidate baseline from `project.json + DEFAULT_VERSIONS`
2. it writes that baseline to `.supabase/stacks/<name>/stack.json`
3. it applies `.supabase/local-versions.json` and any `--service-version` flags on top
4. it writes the exact running version set to `state.json`

When `stack.json` already exists:

1. the CLI uses the pinned baseline from `stack.json`
2. it applies `.supabase/local-versions.json` and any `--service-version` flags on top
3. it writes the exact running version set to `state.json`

So `supabase start` does not silently adopt new linked/default versions for an existing stack.

### `supabase stack status`

`supabase stack status` is local-only. It does not make a network call.

It compares:

- the pinned baseline in `stack.json`
- the candidate baseline from cached linked versions plus current defaults

If they differ, it reports available updates and tells the user to run `supabase stack update`.

### `supabase stack update`

`supabase stack update` is the explicit adoption step.

When the project is linked, it first refreshes the cached linked remote service versions in
`.supabase/project.json`. It then recomputes the candidate baseline and rewrites
`.supabase/stacks/<name>/stack.json`.

It does not start or restart the stack. If the stack is currently running, the CLI warns that the
user must stop and start it again to apply the updated pinned versions.

## 7. User Stories Implemented Today

### Fresh start

For an unlinked project with no local override file and no existing `stack.json`:

- `supabase start` pins the current `DEFAULT_VERSIONS`
- no network fetch is required just to resolve versions

### Linked project

When the project is linked:

- `supabase link` and `supabase stack update` refresh `.supabase/project.json`
- the linked cache feeds the candidate baseline
- existing stacks still keep their pinned `stack.json` versions until `supabase stack update`

### Checkout-local experimentation

When `.supabase/local-versions.json` exists for a project:

- its values override `stack.json`
- the override only affects that checkout
- the override does not change committed config, the linked remote cache, or the pinned baseline

### Per-run overrides

When a user passes `--service-version`:

- those values override both `stack.json` and `.supabase/local-versions.json`
- the override lasts only for that one `supabase start` invocation

### CLI upgrades

When the CLI ships a newer `DEFAULT_VERSIONS` set:

- new stacks can pin the newer defaults immediately
- existing stacks keep their pinned `stack.json` baseline
- `supabase stack status` can show that updates are available
- `supabase stack update` adopts the new linked/default-backed baseline explicitly

### Team collaboration

Linked parity is still not shared through VCS, but it is now visible in the checkout:

1. each developer runs `supabase link` in their own checkout
2. each checkout stores its linked cache in `.supabase/project.json`
3. each named stack stores its pinned baseline in `.supabase/stacks/<name>/stack.json`
4. the files stay gitignored and are not part of committed repo intent

This is intentionally closer to the Vercel model: repo-local gitignored project metadata, plus a
separate global CLI home for auth and caches.

## 8. Service Inventory

These are the services currently represented in `DEFAULT_VERSIONS` and the local stack manifests:

- `postgres`
- `postgrest`
- `auth`
- `realtime`
- `storage`
- `imgproxy`
- `mailpit`
- `pgmeta`
- `studio`
- `analytics`
- `vector`
- `pooler`

`project.json` only caches the subset of linked remote services the CLI can currently probe:

- `postgres`
- `postgrest`
- `auth`
- `storage`

## 9. Future Improvements

The main missing hosted-version improvement is not more local state; it is a cleaner public
Management API route that exposes the remote project's service versions directly.

The current CLI already has the local structure it needs:

- linked remote cache in `.supabase/project.json`
- pinned stack baseline in `.supabase/stacks/<name>/stack.json`
- checkout-local overrides in `.supabase/local-versions.json`
- one-off overrides through `--service-version`
