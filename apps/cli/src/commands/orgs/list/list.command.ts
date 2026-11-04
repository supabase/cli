import { Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { orgsList } from "./list.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {};
export type OrgsListFlags = CliCommand.Command.Config.Infer<typeof config>;

export const orgsListCommand = makeCommand("list", config).pipe(
  Command.withDescription("Show the organizations the logged-in user belongs to, with their IDs."),
  Command.withShortDescription("List all organizations"),
  Command.withExamples([
    {
      command: "supabase orgs list",
      description: "List all organizations you belong to",
    },
    {
      command: "supabase orgs list --output-format json",
      description: "List organizations as JSON",
    },
  ]),
  withPermissions({ operations: [{ operationId: "v1-list-all-organizations", kind: "required" }] }),
  Command.withHandler((flags) =>
    orgsList(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["orgs", "list"])),
  withTargetPolicy({ group: "account", consent: "none" }),
);
