import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { Output } from "../../../shared/output/output.service.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandInstrumentation } from "../../../shared/telemetry/command-instrumentation.ts";
import { schemaRuntimeLayer } from "../../../shared/schema/schema-runtime.layer.ts";
import { diffMigrations } from "../../../shared/migrations/diff-migrations.ts";
import { pullMigrations } from "../../../shared/migrations/pull-migrations.ts";
import { pushMigrations } from "../../../shared/migrations/push-migrations.ts";
import { pullSchema } from "../../../shared/schema/pull-schema.ts";
import { generateSchema } from "../../../shared/schema/generate-schema.ts";
import { applySchema } from "../../../shared/schema/apply-schema.ts";
import { renderSchemaResult } from "../../../shared/schema/schema-render.ts";

const notice = (alias: string, target: string) =>
  Effect.gen(function* () {
    const output = yield* Output;
    yield* output.raw(`Command "${alias}" is deprecated, use "${target}" instead.\n`, "stderr");
  });

const dbDiffFlags = {
  against: Flag.string("against").pipe(Flag.optional),
  file: Flag.string("file").pipe(Flag.withAlias("f"), Flag.optional),
} as const;

const dbDiffCommand = Command.make("diff", dbDiffFlags).pipe(
  Command.withDescription("Deprecated alias for migrations diff."),
  Command.withShortDescription("Deprecated: use migrations diff"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      yield* notice("db diff", "migrations diff");
      const result = yield* diffMigrations({
        against: Option.getOrUndefined(flags.against) ?? "local",
        file: Option.getOrUndefined(flags.file),
      });
      yield* renderSchemaResult("Diff migrations", result);
    }).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(schemaRuntimeLayer(["db", "diff"])),
);

const dbPushFlags = {
  yes: Flag.boolean("yes").pipe(Flag.withAlias("y")),
  projectRef: Flag.string("project-ref").pipe(Flag.optional),
  allowRemote: Flag.boolean("allow-remote"),
  dbUrl: Flag.string("db-url").pipe(Flag.optional),
  skipVerify: Flag.boolean("skip-verify"),
} as const;

const dbPushCommand = Command.make("push", dbPushFlags).pipe(
  Command.withDescription("Deprecated alias for migrations push."),
  Command.withShortDescription("Deprecated: use migrations push"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      yield* notice("db push", "migrations push");
      const result = yield* pushMigrations({
        yes: flags.yes,
        projectRef: Option.getOrUndefined(flags.projectRef),
        allowRemote: flags.allowRemote,
        dbUrl: Option.getOrUndefined(flags.dbUrl),
        skipVerify: flags.skipVerify,
      });
      yield* renderSchemaResult("Push migrations", result);
    }).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(schemaRuntimeLayer(["db", "push"])),
);

const dbPullFlags = {
  from: Flag.string("from").pipe(Flag.optional),
  declarative: Flag.boolean("declarative"),
  output: Flag.string("output").pipe(Flag.optional),
  force: Flag.boolean("force"),
  pruneUnmanaged: Flag.boolean("prune-unmanaged"),
} as const;

const dbPullCommand = Command.make("pull", dbPullFlags).pipe(
  Command.withDescription(
    "Deprecated alias for migrations pull, or schema pull when --declarative is set.",
  ),
  Command.withShortDescription("Deprecated: use schema pull or migrations pull"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (flags.declarative) {
        yield* notice("db pull --declarative", "schema pull --from linked");
        const result = yield* pullSchema({
          from: Option.getOrUndefined(flags.from) ?? "linked",
          output: Option.getOrUndefined(flags.output),
          force: flags.force,
          pruneUnmanaged: flags.pruneUnmanaged,
        });
        yield* renderSchemaResult("Pull declarative schema", result);
        return;
      }
      yield* notice("db pull", "migrations pull");
      const result = yield* pullMigrations({
        from: Option.getOrUndefined(flags.from),
      });
      yield* renderSchemaResult("Pull remote migrations", result);
    }).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(schemaRuntimeLayer(["db", "pull"])),
);

const declarativeGenerateCommand = Command.make("generate").pipe(
  Command.withDescription("Deprecated alias for schema pull."),
  Command.withShortDescription("Deprecated: use schema pull"),
  Command.withHandler(() =>
    Effect.gen(function* () {
      yield* notice("db schema declarative generate", "schema pull");
      const result = yield* pullSchema({ from: "local", force: false, pruneUnmanaged: false });
      yield* renderSchemaResult("Pull declarative schema", result);
    }).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(schemaRuntimeLayer(["db", "schema", "declarative", "generate"])),
);

const declarativeSyncFlags = {
  apply: Flag.boolean("apply"),
  name: Flag.string("name").pipe(Flag.optional),
} as const;

const declarativeSyncCommand = Command.make("sync", declarativeSyncFlags).pipe(
  Command.withDescription("Deprecated alias for schema generate."),
  Command.withShortDescription("Deprecated: use schema generate"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      yield* notice("db schema declarative sync", "schema generate");
      const generated = yield* generateSchema({
        name: Option.getOrUndefined(flags.name),
        dryRun: false,
        baseline: false,
      });
      yield* renderSchemaResult("Generate schema migrations", generated);
      if (flags.apply) {
        const applied = yield* applySchema({
          yes: true,
          allowRemote: false,
        });
        yield* renderSchemaResult("Apply declarative schema", applied);
      }
    }).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(schemaRuntimeLayer(["db", "schema", "declarative", "sync"])),
);

const declarativeCommand = Command.make("declarative").pipe(
  Command.withDescription("Deprecated declarative schema aliases."),
  Command.withSubcommands([declarativeGenerateCommand, declarativeSyncCommand]),
);

const dbSchemaCommand = Command.make("schema").pipe(
  Command.withDescription("Deprecated schema aliases. Use top-level schema."),
  Command.withSubcommands([declarativeCommand]),
);

export const dbCommand = Command.make("db").pipe(
  Command.withDescription("Deprecated database aliases. Prefer schema and migrations."),
  Command.withShortDescription("Deprecated: use schema and migrations"),
  Command.withSubcommands([dbDiffCommand, dbPushCommand, dbPullCommand, dbSchemaCommand]),
);
