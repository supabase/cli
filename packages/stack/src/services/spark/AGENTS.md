# Spark stack services

Owned by `@supabase/cli` and `@supabase/spark` (`.github/CODEOWNERS`); either team approves changes here. The command
side lives in [`apps/cli/src/commands/experimental/spark/`](../../../../../apps/cli/src/commands/experimental/spark/AGENTS.md).
The root [`AGENTS.md`](../../../../../AGENTS.md) rules apply.

## What is here

- `Spark.ts`: the `spark` service kind, a native host process started from `[experimental.spark] executable`.
- `SparkMeta.ts`: the `sparkmeta` service kind, an HTTP server inside the stack owner.
- `SparkClient.ts`, exported as `@supabase/stack/spark`: the admin client (`makeSparkAdmin`), the schema dump, the
  TypeScript types and the dry-run statuses. sparkmeta and the CLI's local target both use it, so each exists once.
- `meta/`: what sparkmeta answers. `Handler.ts` serves Studio's `POST /pg/query` and the stand-in Management API
  (`database/query`, `database/dump`, `database/migrations?dry_run=true`, `types/typescript`); `Dump.ts`, `Typegen.ts`
  and `OpenApi.ts` render from Spark's schema description, `Typegen.ts` through `Model.ts`.

## How sparkmeta routes SQL

Spark's parser (`POST /_spark/v1/parse`) classifies the script. A script with a DDL statement becomes a Spark migration
after a dry run on a scratch copy, and is written to `supabase/migrations`; a refused statement comes back with its own
SQLSTATE and message, and the summary of every refusal in `details`. Everything else goes to Spark's
`/database/query` as sent, with its parameters, and Spark's error comes back unchanged. Studio answers its own catalog
queries: its pg-meta fallbacks match Spark's SQLSTATE and message, so sparkmeta never rewrites either.

## Who calls what

- The CLI's Spark commands on the local target (the default) call Spark's admin routes through the stack's API URL
  with the stack's service_role key: `/database/query`, `/system/v1/migrations` (list, apply, `?dry_run=1`) and
  `/_spark/v1/schema`.
- On a linked target they call the Management API. Locally, sparkmeta's stand-in `/v1/projects/{ref}/...` routes
  answer it: they are the test double of that path and what the standalone MCP server calls.

## Global files that register these kinds

`services/Catalog.ts`, `host/Endpoints.ts` (proxy routes), `composition/Supabase.ts` (links to Studio) and
`Artifacts.ts` (`HostServiceKind`) still name `spark` and `sparkmeta`. They stay with `@supabase/cli`; a change there is
a global change.

## Checks

`pnpm --filter @supabase/stack run types:check`, `bun --bun vitest run --project unit src/services/spark` and
`--project integration src/services/spark` from `packages/stack`, then `apps/cli/scripts/spark/e2e.sh`.
