import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyOrgsList } from "./list.handler.ts";

const config = {};
export type LegacyOrgsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyOrgsListCommand = Command.make("list", config).pipe(
  Command.withDescription("List all organizations the logged-in user belongs."),
  Command.withShortDescription("List all organizations"),
  Command.withHandler((flags) =>
    legacyOrgsList(flags).pipe(withLegacyCommandInstrumentation({ flags }), withJsonErrorHandling),
  ),
  Command.provide(legacyManagementApiRuntimeLayer(["orgs", "list"])),
);
