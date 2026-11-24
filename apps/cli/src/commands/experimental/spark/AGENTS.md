# Spark command tree

Owned by `@supabase/cli` and `@supabase/spark` (`.github/CODEOWNERS`): an approval from either team is enough for
changes inside this folder and `packages/stack/src/services/spark/`. Read
[`apps/cli/AGENTS.md`](../../../../AGENTS.md) and the root [`AGENTS.md`](../../../../../../AGENTS.md) first; their rules
apply here too.

When `[experimental.spark] enabled` is set (or `SUPABASE_EXPERIMENTAL_SPARK_ENABLED`), `src/cli/root.ts` mounts
`init`, the mainline `login`, `logout`, `orgs list`, `projects`, `functions` (no `serve` or `download`) and `secrets`,
and `sparkCommands` from `spark.command.ts`, instead of the mainline tree. Commands Spark does not support are absent,
not stubbed, and never fall back to Postgres. Nothing runs Spark or Studio on the developer's machine: every command
reaches a Spark project through the Management API, and `db diff` and `db pull` use Docker for their shadow Postgres.

`start`, `status` and `stop` (`start/`, `status/`, `stop/`) manage the checkout's dev instance, a Spark project
created through the Management API and recorded in `supabase/.temp/dev-instance.json` (`spark-dev-instance.ts`).
`withSparkTarget` sends a command with no target flag to that instance, and `--remote` to the linked project. A
`db reset` that timed out or was interrupted records `reset_pending` there (and leaves `seeded` alone); `start` and
`db push` refuse through `requireNoPendingReset` until a `db reset` finishes. `start`, `stop --delete` and `db reset`
change the instance only under `withDevInstanceLock`, and write the state file only through `writeDevInstanceState`.
The mainline `functions`, `secrets` and `projects api-keys` leaves are mounted by `root.ts` (this folder may not import
them) through `withSparkDevInstanceProject` (`projects list`, which has no project flags, through
`withSparkDevInstanceDefault`: its soft `resolveOptional` lookup then marks the dev instance), which provides
`DefaultProjectRef` (`config/project-ref.service.ts`) so a leaf with no `--project-ref` or `--remote` resolves the dev
instance, and `FunctionsApiDeployMode` (`shared/functions/deploy.ts`) so `functions deploy` uploads through the API
and prints each function's URL; with neither provided, the mainline tree is unchanged.

`[experimental.spark]` has one key, `enabled`. `dev_instance`, `executable` and `studio_executable` fail when the CLI
starts (`shared/config/experimental-feature.ts`), since this CLI runs no local Spark process or Studio.

## Layout

- `spark.command.ts`: the tree `root.ts` mounts. With `resolveSparkEnabled` in `spark-project.ts`, which
  `src/cli/main.ts` calls to choose the tree, it is the only code outside this folder may import.
- `<group>/<name>/`: one folder per subcommand, `<name>.command.ts` and `<name>.handler.ts`, like
  `experimental/compute/`.
- Family helpers (`spark-api.ts`, `spark-project.ts`, `spark-shadow.ts`, `spark-schema-files.ts`, `spark-target.ts`,
  `spark-apply.ts` (pending migrations and seed files), `spark-dev-instance.ts` (the dev instance and its state file),
  `spark.flags.ts` (the target flags, their TARGET help and the runtime layers), and helpers shared by several
  handlers) sit at the folder root.
- `SIDE_EFFECTS.md`: what each command writes, locally and remotely.

## Adding a command

1. Create `<group>/<name>/` with the command, handler and tests next to them.
2. Add it to the tree in `spark.command.ts`.
3. Reach the project only through `SparkTarget` (`spark-target.ts`): with `withSparkTarget` and `sparkTargetFlags`
   (plus `withSparkTargetHelp`) for a command that targets the dev instance or `--remote`, or `withDevInstanceTarget`
   for one that acts only on the dev instance. Both call the Management API (`spark-api.ts`); the dev instance's
   writes ask for no consent, a linked project's do.
4. Record its writes in `SIDE_EFFECTS.md`.
5. If it changes the end-to-end flow, extend `dev-instance.e2e.test.ts`.

## Boundaries

- Shared code comes from concern slices (`src/command-internal/`, `src/config/`, `src/output/`, `src/shared/`,
  `src/telemetry/`); the pgdelta helpers are in `src/command-internal/db/pgdelta/`. Never import from another command;
  `code-structure.unit.test.ts` fails the build if you do.
- A new config key (`packages/config`) or a change to a shared slice is a global change: it lands in the global file,
  reviewed by `@supabase/cli`, and this folder only uses it.
- A workaround for a Spark gap says TEMPORARY and its exit condition where it lives.

## Checks

From the repository root: `pnpm --filter supabase run types:check`, `pnpm run lint:check`, and the unit and
integration suites. `dev-instance.e2e.test.ts` (project `e2e`) runs the compiled CLI against the test's Management
API stand-in (`apps/cli/tests/helpers/spark-management-api.ts`), which starts its own Spark processes on free ports.
It is skipped unless `SUPABASE_SPARK_BIN` is set, and also needs `SPARK_EXAMPLE_DIR`. From the repository root:

```sh
pnpm exec turbo run supabase#build
SUPABASE_SPARK_BIN=<spark> SPARK_EXAMPLE_DIR=<examples/spark-todos> \
  pnpm --filter supabase exec bun --bun vitest run --project e2e src/commands/experimental/spark/dev-instance.e2e.test.ts
```
