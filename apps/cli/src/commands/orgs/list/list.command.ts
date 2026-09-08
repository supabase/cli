import { Command } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { orgsList } from "./list.handler.ts";

const config = {};
export type OrgsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const orgsListCommand = Command.make("list", config).pipe(
  Command.withDescription("List all organizations the logged-in user belongs."),
  Command.withShortDescription("List all organizations"),
  Command.withHandler((flags) =>
    orgsList(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["orgs", "list"])),
);
