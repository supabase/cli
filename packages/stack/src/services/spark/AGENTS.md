# Spark stack services

Owned by `@supabase/cli` and `@supabase/spark` (`.github/CODEOWNERS`); either team approves changes here. The command
side lives in [`apps/cli/src/commands/experimental/spark/`](../../../../../apps/cli/src/commands/experimental/spark/AGENTS.md).
The root [`AGENTS.md`](../../../../../AGENTS.md) rules apply.

## What is here

- `Spark.ts`: the `spark` service kind, a native host process started from `[experimental.spark] executable`.
- `SparkMeta.ts`: the `sparkmeta` service kind, an HTTP server inside the stack owner.
- `meta/`: what sparkmeta answers. `Handler.ts` routes Studio's pg-meta calls and the stand-in Management API
  (`database/dump`, `database/migrations?dry_run=true`, `types/typescript`); `Dump.ts`, `Typegen.ts` and `OpenApi.ts`
  render from Spark's schema description; `Catalog.ts` and `StudioShims.ts` are TEMPORARY until Studio answers its
  own catalog queries.

## Global files that register these kinds

`services/Catalog.ts`, `host/Endpoints.ts` (proxy routes), `composition/Supabase.ts` (links to Studio) and
`Artifacts.ts` (`HostServiceKind`) still name `spark` and `sparkmeta`. They stay with `@supabase/cli`; a change there is
a global change.

## Checks

`pnpm --filter @supabase/stack run types:check`, `bun --bun vitest run --project unit src/services/spark` and
`--project integration src/services/spark` from `packages/stack`, then `apps/cli/scripts/spark/e2e.sh`.
