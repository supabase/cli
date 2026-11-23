# Spark stack services

Owned by `@supabase/cli` and `@supabase/spark` (`.github/CODEOWNERS`); either team approves changes here. The command
side lives in [`apps/cli/src/commands/experimental/spark/`](../../../../../apps/cli/src/commands/experimental/spark/AGENTS.md).
The root [`AGENTS.md`](../../../../../AGENTS.md) rules apply.

## What is here

- `Spark.ts`: the `spark` service kind, a native host process started from `[experimental.spark] executable`.
- `SparkMeta.ts`: the `sparkmeta` service kind, an HTTP server inside the stack owner.
- `SparkClient.ts`, exported as `@supabase/stack/spark`: the admin client (`makeSparkAdmin`, which also fetches
  Spark's dump), the TypeScript types and the dry-run statuses (`SparkDryRunStatus`, the one schema for them). sparkmeta and the CLI's local target both use it, so each exists once.
- `meta/`: what sparkmeta answers. `Handler.ts` serves Studio's `POST /pg/query` and the stand-in Management API
  (`database/query`, `database/dump`, `database/migrations?dry_run=true`, `types/typescript`). The dump comes from Spark
  (`/_spark/v1/dump`) and `GET /rest/v1/` (the OpenAPI document) is Spark's own route, not sparkmeta's; `Typegen.ts` maps
  Spark's schema description with `@supabase/typegen`'s `sparkGeneratorMetadata`, which comes from a git branch of
  `supabase/sdk` until it is released.

## How sparkmeta routes SQL

Spark's parser (`POST /_spark/v1/parse`) classifies the script. A script with a DDL statement becomes a Spark migration
after Spark's dry run of it on the project's database, and is written to `supabase/migrations`; a refused statement comes back with its own
SQLSTATE and message, and the summary of every refusal in `details`. Everything else goes to Spark's
`/database/query` as sent, with its parameters, and Spark's error comes back unchanged, with Spark's own `formattedError`; sparkmeta formats only the errors it raises itself. Studio answers its own catalog
queries: its pg-meta fallbacks match Spark's SQLSTATE and message, so sparkmeta never rewrites either.

## Who calls what

- The CLI's Spark commands on the local target (the default) call Spark's admin routes through the stack's API URL
  with the stack's service_role key: `/database/query`, `/system/v1/migrations` (list, apply, `?dry_run=1`) ,
  `/_spark/v1/dump` and `/_spark/v1/schema`.
- On a linked target they call the Management API. Locally, sparkmeta's stand-in `/v1/projects/{ref}/...` routes
  answer it: they are the test double of that path and what the standalone MCP server calls.

## Global files that register these kinds

`services/Catalog.ts`, `host/Endpoints.ts` (proxy routes), `composition/Supabase.ts` (links to Studio) and
`Artifacts.ts` (`HostServiceKind`) still name `spark` and `sparkmeta`. They stay with `@supabase/cli`; a change there is
a global change.

## Checks

`pnpm --filter @supabase/stack run types:check`, `bun --bun vitest run --project unit src/services/spark` and
`--project integration src/services/spark` from `packages/stack`, then the Spark end-to-end test (`apps/cli/src/commands/experimental/spark/spark.e2e.test.ts`, run as described in that folder's `AGENTS.md`).
