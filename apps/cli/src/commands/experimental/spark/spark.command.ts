import { Effect, Layer, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { commandSettingsLayer } from "../../../config/command-settings.layer.ts";
import { debugLoggerLayer } from "../../../command-internal/debug-logger.layer.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { parseSchemaFlags } from "../../../command-internal/schema-flags.ts";
import { stackApiLayer } from "../../../command-internal/stack-api.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { telemetryStateLayer } from "../../../telemetry/telemetry-state.layer.ts";
import {
  sparkDbDiff,
  sparkDbPull,
  sparkDbPush,
  sparkDbReset,
  sparkGenTypes,
  sparkLink,
  sparkMigrationList,
} from "../../../command-internal/spark/spark-db.ts";
import { SparkApiError } from "../../../command-internal/spark/spark-project.ts";
import { sparkShadowLayer } from "../../../command-internal/spark/spark-shadow.ts";
import { sparkStackLayer } from "../../../command-internal/spark/spark-stack.ts";

const projectRef = Flag.String("project-ref").pipe(
  Flag.withDescription("Project ref of the Spark project; defaults to the linked project."),
  Flag.optional,
);

const schema = Flag.String("schema").pipe(
  Flag.withAlias("s"),
  Flag.withDescription("Comma separated list of schema to include."),
  Flag.atLeast(0),
  Flag.mapTryCatch(
    (rawValues) => parseSchemaFlags(rawValues),
    (err) => (err instanceof Error ? err.message : String(err)),
  ),
);

/** Spark's `db diff` and `db pull` also run a shadow Postgres from the project's config. */
const shadowRuntimeLayer = (subcommand: ReadonlyArray<string>) =>
  Layer.mergeAll(managementApiRuntimeLayer(subcommand), sparkShadowLayer);

const diffConfig = {
  projectRef,
  schema,
  file: Flag.String("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Saves the schema diff as a new migration with this name."),
    Flag.optional,
  ),
} as const;

const sparkDbDiffCommand = Command.make("diff", diffConfig).pipe(
  Command.withDescription(
    "Plans supabase/schemas against the project's dump in a shadow Postgres, then dry-runs the migration on Spark. Statements Spark refuses are reported and nothing is written.",
  ),
  Command.withShortDescription("Diffs the schema files against the Spark project"),
  Command.withHandler((flags) =>
    sparkDbDiff(flags).pipe(
      withCommandTelemetry({
        flags: { file: flags.file, schema: flags.schema },
        aliases: { f: "file", s: "schema" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(shadowRuntimeLayer(["db", "diff"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(diffConfig),
);

const pullConfig = { projectRef, schema } as const;

const sparkDbPullCommand = Command.make("pull", pullConfig).pipe(
  Command.withDescription(
    "Loads the project's dump into a shadow Postgres and exports it to supabase/schemas.",
  ),
  Command.withShortDescription("Pulls the Spark project's schema"),
  Command.withHandler((flags) =>
    sparkDbPull(flags).pipe(
      withCommandTelemetry({ flags: { schema: flags.schema }, aliases: { s: "schema" } }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(shadowRuntimeLayer(["db", "pull"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(pullConfig),
);

const sparkDbPushCommand = Command.make("push", { projectRef }).pipe(
  Command.withDescription(
    "Dry-runs each pending migration on Spark, then applies it with its local version.",
  ),
  Command.withShortDescription("Pushes new migrations to the Spark project"),
  Command.withHandler((flags) =>
    sparkDbPush(flags).pipe(withCommandTelemetry(), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["db", "push"])),
);

const sparkDbResetCommand = Command.make("reset", {}).pipe(
  Command.withDescription(
    "Rebuilds the local Spark stack's database from migrations and seed files.",
  ),
  Command.withShortDescription("Resets the local Spark database"),
  Command.withHandler(() => sparkDbReset.pipe(withCommandTelemetry(), withJsonErrorHandling)),
  Command.provide(
    Layer.mergeAll(
      sparkStackLayer.pipe(Layer.provide(stackApiLayer)),
      telemetryStateLayer,
      commandRuntimeLayer(["db", "reset"]),
    ).pipe(Layer.provideMerge(commandSettingsLayer.pipe(Layer.provide(debugLoggerLayer)))),
  ),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags({}),
);

const sparkDbCommand = Command.make("db").pipe(
  Command.withDescription("Manage the Spark project's database schema and migrations."),
  Command.withShortDescription("Manage databases"),
  Command.withSubcommands([
    sparkDbDiffCommand,
    sparkDbPullCommand,
    sparkDbPushCommand,
    sparkDbResetCommand,
  ]),
);

const sparkMigrationListCommand = Command.make("list", { projectRef }).pipe(
  Command.withDescription("Lists local migration files and the Spark project's migration history."),
  Command.withShortDescription("List local and remote migrations"),
  Command.withHandler((flags) =>
    sparkMigrationList(flags).pipe(withCommandTelemetry(), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["migration", "list"])),
);

const sparkMigrationCommand = Command.make("migration").pipe(
  Command.withDescription("Manage database migration scripts."),
  Command.withShortDescription("Manage database migration scripts"),
  Command.withAlias("migrations"),
  Command.withSubcommands([sparkMigrationListCommand]),
);

const genTypesConfig = {
  projectRef,
  schema,
  lang: Flag.Literals("lang", ["typescript"]).pipe(
    Flag.withDescription("Output language of the generated types."),
    Flag.withDefault("typescript"),
  ),
  language: Argument.String("language").pipe(Argument.optional),
} as const;

const sparkGenTypesCommand = Command.make("types", genTypesConfig).pipe(
  Command.withDescription("Generates TypeScript types from the Spark project's schema."),
  Command.withShortDescription("Generate types from the Spark project"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (Option.isSome(flags.language) && flags.language.value !== "typescript")
        return yield* new SparkApiError({
          message: `only typescript types are generated for a Spark project, not ${flags.language.value}`,
        });
      yield* sparkGenTypes(flags);
    }).pipe(
      withCommandTelemetry({
        flags: { lang: flags.lang, schema: flags.schema },
        aliases: { s: "schema" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(managementApiRuntimeLayer(["gen", "types"])),
);

const sparkGenCommand = Command.make("gen").pipe(
  Command.withDescription("Run code generation tools."),
  Command.withShortDescription("Run code generation tools"),
  Command.withSubcommands([sparkGenTypesCommand]),
);

const sparkLinkCommand = Command.make("link", { projectRef }).pipe(
  Command.withDescription("Links this checkout to a Spark project through the Management API."),
  Command.withShortDescription("Link to a Spark project"),
  Command.withHandler((flags) =>
    sparkLink(flags).pipe(withCommandTelemetry(), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["link"])),
);

/** The commands a Spark project's tree adds to `init` and the local stack harness. */
export const sparkCommands = [
  sparkLinkCommand,
  sparkDbCommand,
  sparkMigrationCommand,
  sparkGenCommand,
] as const;
