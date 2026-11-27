import { withSidebar } from "../../../command-internal/command-sidebar.ts";
import { Schema } from "effect";
import { Argument, Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withManagedHandler } from "../../../command-internal/command-executor.ts";
import { migrationNewRuntime } from "../migration.layers.ts";
import { createdMessage, migrationNew } from "./new.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  migrationName: Argument.String("migration name").pipe(
    Argument.withDescription("Name for the new migration file."),
  ),
} as const;

export type MigrationNewFlags = CliCommand.Command.Config.Infer<typeof config>;

const MigrationNewResult = Schema.Struct({
  path: Schema.String,
  message: Schema.Literal("Migration created"),
});

export const migrationNewCommand = Command.make("new", config).pipe(
  withSidebar({ title: "Create a migration" }),
  Command.withDescription("Create an empty migration script."),
  Command.withShortDescription("Create an empty migration script"),
  withPermissions({ operations: [] }),
  withManagedHandler({
    output: MigrationNewResult,
    handler: migrationNew,
    runtime: migrationNewRuntime,
    hooks: {
      onResultReady: ({ path }, { ux, relativeToWorkdir }) =>
        ux.stdoutLine(createdMessage(relativeToWorkdir(path))),
    },
  }),
  withTargetPolicy({ group: "local-only", consent: "none" }),
);
