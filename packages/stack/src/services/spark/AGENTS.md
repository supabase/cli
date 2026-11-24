# Spark client

Owned by `@supabase/cli` and `@supabase/spark` (`.github/CODEOWNERS`); either team approves changes here. The command
side lives in [`apps/cli/src/commands/experimental/spark/`](../../../../../apps/cli/src/commands/experimental/spark/AGENTS.md).
The root [`AGENTS.md`](../../../../../AGENTS.md) rules apply.

This folder is not a stack service: the stack runs no Spark process. It holds the client for a Spark server's own
routes, exported as `@supabase/stack/spark` (`SparkClient.ts`).

## What is here

- `SparkClient.ts`: the dry-run statuses (`SparkDryRunStatus`, the one schema for them, which the CLI's Management API
  client decodes), `sparkDryRun`, `sparkTypescriptTypes`, and the re-exported admin client.
- `Admin.ts`: the client for Spark's admin routes (`/database/query`, `/system/v1/migrations`, `/_spark/v1/dump`,
  `/_spark/v1/schema`). `Description.ts`: Spark's schema description (`GET /_spark/v1/schema`). `Typegen.ts` maps that
  description with `@supabase/typegen`'s `sparkGeneratorMetadata`, which comes from a git branch of `supabase/sdk`
  until it is released.

## Who calls what

- The CLI's Spark commands call the Management API only; they import `SparkDryRunStatus` from here.
- The test-only Management API stand-in (`apps/cli/tests/helpers/spark-management-api.ts`), which the dev-instance
  end-to-end test starts, serves its routes from Spark processes through `makeSparkAdmin`, `sparkDryRun` and
  `sparkTypescriptTypes`.

## Checks

`pnpm --filter @supabase/stack run types:check` and `bun --bun vitest run --project unit src/services/spark` from
`packages/stack`, then the dev-instance end-to-end test, run as described in the command folder's `AGENTS.md`.
