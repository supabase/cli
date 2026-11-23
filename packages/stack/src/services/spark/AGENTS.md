# Spark stack services

Owned by `@supabase/cli` and `@supabase/spark` (`.github/CODEOWNERS`); either team approves changes here. The command
side lives in [`apps/cli/src/commands/experimental/spark/`](../../../../../apps/cli/src/commands/experimental/spark/AGENTS.md).
The root [`AGENTS.md`](../../../../../AGENTS.md) rules apply.

## What is here

- `Spark.ts`: the `spark` service kind, a native host process started from `[experimental.spark] executable`.
- `SparkClient.ts`, exported as `@supabase/stack/spark`: the admin client (`makeSparkAdmin`, which also fetches
  Spark's dump), the TypeScript types and the dry-run statuses (`SparkDryRunStatus`, the one schema for them). The
  CLI's local target and the Spark end-to-end test's stand-in Management API both use it, so each exists once.
- `Admin.ts`: the client for Spark's admin routes. `Description.ts`: Spark's schema description
  (`GET /_spark/v1/schema`). `Typegen.ts` maps that description with `@supabase/typegen`'s `sparkGeneratorMetadata`,
  which comes from a git branch of `supabase/sdk` until it is released.

## Who calls what

- Studio posts its SQL to `STUDIO_PG_META_URL`, `<api url>/pg`. The proxy sends `POST /pg/query` to Spark's
  `POST /database/query` unchanged (the `spark` routes in `host/Endpoints.ts`): Spark runs it, schema changes
  included, and records no migration. Studio reads the engine from `POSTGRES_ENGINE=spark` in its environment.
- The CLI's Spark commands on the local target (the default) call Spark's admin routes through the stack's API URL
  with the stack's service_role key: `/database/query`, `/system/v1/migrations` (list, apply, `?dry_run=1`),
  `/_spark/v1/dump` and `/_spark/v1/schema`.
- On a linked target they call the Management API. The stack serves none of it; the end-to-end test starts its own
  stand-in (`apps/cli/tests/helpers/spark-management-api.ts`) for its `--remote` steps and the MCP server.

## Global files that register this kind

`services/Catalog.ts`, `host/Endpoints.ts` (proxy routes), `composition/Supabase.ts` (Studio's pg-meta URL) and
`Artifacts.ts` (`HostServiceKind`) name `spark`. They stay with `@supabase/cli`; a change there is a global change.

## Checks

`pnpm --filter @supabase/stack run types:check`, `bun --bun vitest run --project unit src/services/spark` and
`--project integration src/services/spark` from `packages/stack`, then the Spark end-to-end test (`apps/cli/src/commands/experimental/spark/spark.e2e.test.ts`, run as described in that folder's `AGENTS.md`).
