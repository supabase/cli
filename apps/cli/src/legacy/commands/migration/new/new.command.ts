import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyMigrationNewRuntimeLayer } from "../migration.layers.ts";
import { legacyMigrationNew } from "./new.handler.ts";

const config = {
  migrationName: Argument.string("migration name").pipe(
    Argument.withDescription("Name for the new migration file."),
  ),
} as const;

export type LegacyMigrationNewFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyMigrationNewCommand = Command.make("new", config).pipe(
  Command.withDescription("Create an empty migration script."),
  Command.withShortDescription("Create an empty migration script"),
  Command.withHandler((flags) =>
    legacyMigrationNew(flags).pipe(withLegacyCommandInstrumentation(), withJsonErrorHandling),
  ),
  Command.provide(legacyMigrationNewRuntimeLayer),
);
