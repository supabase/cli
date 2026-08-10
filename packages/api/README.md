# @supabase/api

Generated Supabase Management API SDK built directly from the Supabase OpenAPI spec.

> **Temporary (CLI-2157):** the committed snapshot on this branch is generated from staging
> (`api.supabase.green`) because `GET /v2/projects/{ref}/config` (`api.v2.getProjectConfig`,
> schema `V2ProjectConfigResponse`) has not shipped to production yet. Develop's hourly prod sync
> (`api-package-sync.yml`) would remove exactly that endpoint once this merges. Before merging,
> either the endpoint must ship to production or the snapshot must be regenerated from production
> by re-pointing `scripts/openapi-source.json`.

The package exposes:

- `@supabase/api` for the runtime-specific Promise client helpers plus generated contracts
- `@supabase/api/effect` for the Effect-native versioned client plus generated contracts
- `@supabase/api/openapi.json` for the raw generated OpenAPI document
- `openApiOperationIdMap` for tools that need to join raw OpenAPI operation ids to SDK operation ids

## Usage

```ts
import { createApiClient } from "@supabase/api";

const client = await createApiClient({ accessToken: "<token>" });

const projects = await client.v1.listAllProjects();
const projectConfig = await client.v2.getProjectConfig({ ref: "<project-ref>" });
```

Operations are namespaced by version, derived from the leading path segment (`/v1/...` or
`/v2/...`). Same-named operations can coexist under separate namespaces: `client.v1.listOrganizationMembers`
and `client.v2.listOrganizationMembers` are distinct operations hitting `/v1/...` and `/v2/...`
respectively.

`baseUrl` defaults to `https://api.supabase.com` and `accessToken` can also come from
`SUPABASE_ACCESS_TOKEN`.

For Effect consumers:

```ts
import { Effect } from "effect";
import { makeApiClient } from "@supabase/api/effect";

const program = Effect.gen(function* () {
  const client = yield* makeApiClient({ accessToken: "<token>" });

  const projects = yield* client.v1.listAllProjects();
  const projectConfig = yield* client.v2.getProjectConfig({ ref: "<project-ref>" });

  return { projects, projectConfig };
});
```

If you want the package to resolve both values from the environment, you can omit the config
entirely:

```ts
const client = await createApiClient();
```

Supported environment variables:

- `SUPABASE_API_URL` (optional, defaults to `https://api.supabase.com`)
- `SUPABASE_ACCESS_TOKEN` (optional if `accessToken` is passed explicitly)

The only callable client surface is the versioned namespace:

```ts
const projects = await client.v1.listAllProjects();
const projectConfig = await client.v2.getProjectConfig({ ref: "<project-ref>" });
```

For tools that need the raw generated spec:

```ts
import openApiSpec from "@supabase/api/openapi.json";
```

## Binary request bodies

The SDK supports binary request inputs for the Management API routes that use raw eszip bodies or multipart file uploads.

The public binary input contract is:

- `Uint8Array`
- `ArrayBuffer`
- `Blob`

`Uint8Array` is the canonical byte type. For the full internal contract and encoding rules, see [`docs/request-body-encoding.md`](./docs/request-body-encoding.md).

## Development

```sh
pnpm check:all       # Run all quality checks in parallel
pnpm fix:all         # Auto-fix lint, format, and unused exports in parallel
pnpm test            # Run tests
pnpm generate        # Refresh the OpenAPI spec and regenerate the SDK
pnpm generate:check  # Regenerate in place and fail on any resulting diff
```

## Spec pipeline

The spec is built from two upstream OpenAPI documents, `{baseUrl}/api/v1-json` and
`{baseUrl}/api/v2-json`. They are fetched and merged into a single document (paths and
`components.schemas` are unioned, and `info.title` is normalized to `Supabase API`), then
overrides from `scripts/openapi-overrides.json` are applied to the merged document. The result is
validated — operation ids must be unique, and version-prefixed operation ids must match the
path's leading segment — before being written to `src/generated/openapi.json`.

The base URL is resolved in this order:

1. `SUPABASE_API_URL` environment variable
2. `scripts/openapi-source.json`, a committed sidecar file (`{ "baseUrl": ... }`) that is
   rewritten after every successful `pnpm generate` run
3. `https://api.supabase.com`

To refresh from staging instead of production:

```sh
SUPABASE_API_URL=https://api.supabase.green pnpm generate
```

`pnpm generate` is the single command to regenerate the spec and SDK. `pnpm generate:check`
regenerates in place, formats, and fails if that produces any diff in `src/generated` or
`scripts/openapi-source.json` — useful for verifying the committed snapshot is still current. If a
failed check leaves an unwanted diff, discard it with:

```sh
git restore -- src/generated scripts/openapi-source.json
```

The hourly [`api-package-sync.yml`](../../.github/workflows/api-package-sync.yml) workflow runs
`generate` against production and opens a PR against `develop` whenever it detects drift, acting
as the automated drift detector for the committed snapshot.

### Overrides

`scripts/openapi-overrides.json` is a JSON-Patch-_like_ array applied to the merged document. It
supports:

- `test` — assert a value at `path` before proceeding (as in RFC 6902)
- `add` — add a value at `path`; throws if the key already exists
- `replace` — replace the value at `path`
- `remove` — remove the value at `path` **if present**

`remove` is deliberately remove-if-present rather than RFC 6902's strict "must exist" semantics,
because the upstream documents differ between environments — staging's `v2-json` is currently
served by two backend variants that disagree about some paths. Entries may carry a `$comment`
field to document why an override exists.

### Known limitation: `deepObject` query parameters

Three v2 operations declare object-valued query parameters with `style: deepObject`:
`v2-list-organization-members`, `v2-list-organization-projects`, and
`v2-list-organization-github-connections`. The client currently serializes these as JSON strings
rather than the expected `page[size]=...` form. Do not rely on those parameters until this is
fixed.
