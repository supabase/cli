import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyPostgresConfigDelete } from "./delete.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  config: Flag.string("config").pipe(
    Flag.withDescription("Config keys to delete (comma-separated)"),
    Flag.atLeast(0),
  ),
  noRestart: Flag.boolean("no-restart").pipe(
    Flag.withDescription("Do not restart the database after deleting config."),
  ),
} as const;

export type LegacyPostgresConfigDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyPostgresConfigDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription("Delete specific Postgres database config overrides."),
  Command.withShortDescription("Delete Postgres database config overrides"),
  Command.withHandler((flags) =>
    legacyPostgresConfigDelete(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["postgres-config", "delete"])),
);
