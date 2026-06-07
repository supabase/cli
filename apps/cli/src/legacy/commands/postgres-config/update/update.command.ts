import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyPostgresConfigUpdate } from "./update.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  config: Flag.string("config").pipe(
    Flag.withDescription("Config overrides specified as a 'key=value' pair"),
    Flag.atLeast(0),
  ),
  replaceExistingOverrides: Flag.boolean("replace-existing-overrides").pipe(
    Flag.withDescription(
      "If true, replaces all existing overrides with the ones provided. If false (default), merges existing overrides with the ones provided.",
    ),
  ),
  noRestart: Flag.boolean("no-restart").pipe(
    Flag.withDescription("Do not restart the database after updating config."),
  ),
} as const;

export type LegacyPostgresConfigUpdateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyPostgresConfigUpdateCommand = Command.make("update", config).pipe(
  Command.withDescription("Update Postgres database config."),
  Command.withShortDescription("Update Postgres database config"),
  Command.withHandler((flags) =>
    legacyPostgresConfigUpdate(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["postgres-config", "update"])),
);
