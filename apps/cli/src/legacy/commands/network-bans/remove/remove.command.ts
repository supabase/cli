import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyNetworkBansRemove } from "./remove.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  dbUnbanIp: Flag.string("db-unban-ip").pipe(
    Flag.withDescription("IP to allow DB connections from."),
    Flag.atLeast(0),
  ),
} as const;

export type LegacyNetworkBansRemoveFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyNetworkBansRemoveCommand = Command.make("remove", config).pipe(
  Command.withDescription("Remove a network ban."),
  Command.withShortDescription("Remove a network ban"),
  Command.withHandler((flags) =>
    legacyNetworkBansRemove(flags).pipe(
      withLegacyCommandInstrumentation({ flags }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["network-bans", "remove"])),
);
