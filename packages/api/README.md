# @supabase/api

Generated Supabase Management API SDK built directly from the Supabase OpenAPI spec.

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
```

`baseUrl` defaults to `https://api.supabase.com` and `accessToken` can also come from
`SUPABASE_ACCESS_TOKEN`.

For Effect consumers:

```ts
import { Effect } from "effect";
import { makeApiClient } from "@supabase/api/effect";

const program = Effect.gen(function* () {
  const client = yield* makeApiClient({ accessToken: "<token>" });

  return yield* client.v1.listAllProjects();
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
pnpm check:all   # Run all quality checks in parallel
pnpm fix:all     # Auto-fix lint, format, and unused exports in parallel
pnpm test        # Run tests
pnpm generate    # Refresh the OpenAPI spec and regenerate the SDK
```

To refresh from staging instead of production:

```sh
SUPABASE_API_URL=https://api.supabase.green pnpm generate
```
