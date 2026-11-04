import { Argument, Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { migrationNewRuntimeLayer } from "../migration.layers.ts";
import { migrationNew } from "./new.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  migrationName: cliArgument("migration name", Argument.String, {
    description: "Name for the new migration file.",
    required: true,
  }),
} as const;

export type MigrationNewFlags = CliCommand.Command.Config.Infer<typeof config>;

export const migrationNewCommand = makeCommand("new", config).pipe(
  Command.withDescription(
    "Create an empty, timestamped SQL file in supabase/migrations for you to fill in. Output from other commands, such as db diff, can be piped to it.",
  ),
  Command.withShortDescription("Create an empty migration file"),
  withPermissions({ operations: [] }),
  Command.withHandler((flags) =>
    migrationNew(flags).pipe(withCommandTelemetry(), withJsonErrorHandling),
  ),
  Command.provide(migrationNewRuntimeLayer),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
