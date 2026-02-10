# @supabase/api

Auto-generated TypeScript client for the Supabase Management API, built on `openapi-fetch`.

## Usage

```ts
import { createApiClient, type ApiClient } from "@supabase/api";

const client = createApiClient({
  baseUrl: "https://api.supabase.com",
  accessToken: "<token>",
});

const { data } = await client.GET("/v1/projects");
```

The `paths`, `components`, and `operations` types are also exported for direct use with `openapi-fetch`.

## Development

```sh
bun run --parallel "*:check"   # Run all quality checks in parallel
bun run --parallel "*:fix"     # Auto-fix lint, format, and unused exports in parallel
bun test                       # Run tests
bun run generate               # Regenerate types from the OpenAPI spec
```
