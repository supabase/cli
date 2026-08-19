import { Effect, Option } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { Output } from "../../../shared/output/output.service.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandInstrumentation } from "../../../shared/telemetry/command-instrumentation.ts";
import { schemaRuntimeLayer } from "../../../shared/schema/schema-runtime.layer.ts";
import { applyMigrations } from "../../../shared/migrations/apply-migrations.ts";
import { listMigrations } from "../../../shared/migrations/list-migrations.ts";
import { newMigration } from "../../../shared/migrations/new-migration.ts";
import { renderSchemaResult } from "../../../shared/schema/schema-render.ts";

const notice = (alias: string, target: string) =>
  Effect.gen(function* () {
    const output = yield* Output;
    yield* output.raw(`Command "${alias}" is deprecated, use "${target}" instead.\n`, "stderr");
  });

const newArgs = {
  name: Argument.string("name").pipe(Argument.optional),
} as const;

const migrationNewCommand = Command.make("new", newArgs).pipe(
  Command.withDescription("Deprecated alias for migrations new."),
  Command.withShortDescription("Deprecated: use migrations new"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      yield* notice("migration new", "migrations new");
      const result = yield* newMigration(Option.getOrUndefined(flags.name));
      yield* renderSchemaResult("Create migration", result);
    }).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(schemaRuntimeLayer(["migration", "new"])),
);

const migrationListCommand = Command.make("list").pipe(
  Command.withDescription("Deprecated alias for migrations list."),
  Command.withShortDescription("Deprecated: use migrations list"),
  Command.withHandler(() =>
    Effect.gen(function* () {
      yield* notice("migration list", "migrations list");
      const result = yield* listMigrations({});
      yield* renderSchemaResult("List migrations", result);
    }).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(schemaRuntimeLayer(["migration", "list"])),
);

const migrationUpCommand = Command.make("up").pipe(
  Command.withDescription("Deprecated alias for migrations apply."),
  Command.withShortDescription("Deprecated: use migrations apply"),
  Command.withHandler(() =>
    Effect.gen(function* () {
      yield* notice("migration up", "migrations apply");
      const result = yield* applyMigrations();
      yield* renderSchemaResult("Apply migrations", result);
    }).pipe(withCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(schemaRuntimeLayer(["migration", "up"])),
);

export const migrationCommand = Command.make("migration").pipe(
  Command.withDescription("Deprecated singular alias for migrations."),
  Command.withShortDescription("Deprecated: use migrations"),
  Command.withSubcommands([migrationNewCommand, migrationListCommand, migrationUpCommand]),
);
