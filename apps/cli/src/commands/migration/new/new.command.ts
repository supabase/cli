import { Argument, Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { migrationNewRuntimeLayer } from "../migration.layers.ts";
import { migrationNew } from "./new.handler.ts";

const config = {
  migrationName: Argument.String("migration name").pipe(
    Argument.withDescription("Name for the new migration file."),
  ),
} as const;

export type MigrationNewFlags = CliCommand.Command.Config.Infer<typeof config>;

export const migrationNewCommand = Command.make("new", config).pipe(
  Command.withDescription("Create an empty migration script."),
  Command.withShortDescription("Create an empty migration script"),
  Command.withHandler((flags) =>
    migrationNew(flags).pipe(withCommandTelemetry(), withJsonErrorHandling),
  ),
  Command.provide(migrationNewRuntimeLayer),
);
