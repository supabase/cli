# Spark command tree

Owned by `@supabase/cli` and `@supabase/spark` (`.github/CODEOWNERS`): an approval from either team is enough for
changes inside this folder and `packages/stack/src/services/spark/`. Read
[`apps/cli/AGENTS.md`](../../../../AGENTS.md) and the root [`AGENTS.md`](../../../../../../AGENTS.md) first; their rules
apply here too.

When `[experimental.spark] enabled` is set (or `SUPABASE_EXPERIMENTAL_SPARK_ENABLED`), `src/cli/root.ts` mounts
`sparkCommands` from `spark.command.ts` instead of the mainline tree. Commands Spark does not support are absent, not
stubbed, and never fall back to Postgres.

## Layout

- `spark.command.ts`: the tree `root.ts` mounts. With `resolveSparkEnabled` in `spark-project.ts`, which
  `src/cli/main.ts` calls to choose the tree, it is the only code outside this folder may import.
- `<group>/<name>/`: one folder per subcommand, `<name>.command.ts` and `<name>.handler.ts`, like
  `experimental/compute/`.
- Family helpers (`spark-api.ts`, `spark-project.ts`, `spark-shadow.ts`, `spark-stack.ts`, `spark-schema-files.ts`,
  `spark-target.ts`, and helpers shared by several handlers) sit at the folder root.
- `SIDE_EFFECTS.md`: what each command writes, locally and remotely.

## Adding a command

1. Create `<group>/<name>/` with the command, handler and tests next to them.
2. Add it to the tree in `spark.command.ts`.
3. Reach the project only through `SparkTarget` (`spark-target.ts`), with `withSparkTarget`: the local target calls
   the Spark server through the stack's API URL with the stack's service_role key (the `@supabase/stack/spark`
   client), a linked target the Management API (`spark-api.ts`). No other calls to Spark's admin routes.
4. Record its writes in `SIDE_EFFECTS.md`.
5. If it changes the end-to-end flow, extend `spark.e2e.test.ts`.

## Boundaries

- Shared code comes from concern slices (`src/command-internal/`, `src/config/`, `src/output/`, `src/shared/`,
  `src/telemetry/`); the pgdelta helpers are in `src/command-internal/db/pgdelta/`. Never import from another command;
  `code-structure.unit.test.ts` fails the build if you do.
- A new config key (`packages/config`), a new stack capability, a proxy policy, or a change to the stack start or
  status commands is a global change: it lands in the global file, reviewed by `@supabase/cli`, and this folder only
  uses it.
- A workaround for a Spark gap says TEMPORARY and its exit condition where it lives.

## Checks

From the repository root: `pnpm --filter supabase run types:check`, `pnpm run lint:check`, the unit and
integration suites, and the end-to-end scenario, `spark.e2e.test.ts` in this folder. It runs the compiled CLI and is
skipped unless `SUPABASE_SPARK_BIN` is set; with it set, `SPARK_EXAMPLE_DIR` (with `bun install` run),
`SUPABASE_MCP_CLI` and `SUPABASE_SPARK_STUDIO_BIN` are required, and a browser for the Studio check
(`CHROMIUM_PATH`). From the repository root:

```sh
pnpm exec turbo run supabase#build
SUPABASE_SPARK_BIN=<spark> SPARK_EXAMPLE_DIR=<examples/spark-todos> SUPABASE_MCP_CLI=<mcp cli.js> \
  SUPABASE_SPARK_STUDIO_BIN=<studio launcher> \
  pnpm --filter supabase exec bun --bun vitest run --project e2e-exclusive src/commands/experimental/spark/spark.e2e.test.ts
```
