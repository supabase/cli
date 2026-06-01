import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyPostgresConfigGet } from "./get.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
} as const;

export type LegacyPostgresConfigGetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyPostgresConfigGetCommand = Command.make("get", config).pipe(
  Command.withDescription("Get the current Postgres database config overrides."),
  Command.withShortDescription("Get Postgres database config"),
  Command.withHandler((flags) =>
    legacyPostgresConfigGet(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["postgres-config", "get"])),
);
