# @supabase/config

Supabase configuration reference defined as a JSON Schema. Generates both a TypeScript type (`SupabaseConfig`) and a `schema.json` file.

## Usage

```ts
import type { SupabaseConfig } from "@supabase/config";
```

The JSON Schema is available at `@supabase/config/schema.json`.

## Development

```sh
bun run --parallel "*:check"   # Run all quality checks in parallel
bun run --parallel "*:fix"     # Auto-fix lint, format, and unused exports in parallel
bun test                       # Run tests
bun run build                  # Generate dist/types.d.ts and dist/schema.json
```
