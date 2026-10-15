import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { domainsDelete } from "./delete.handler.ts";

const config = {
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  includeRawOutput: Flag.Boolean("include-raw-output").pipe(
    Flag.withDescription("(Deprecated) use -o json instead."),
    Flag.optional,
  ),
} as const;

export type DomainsDeleteFlags = CliCommand.Command.Config.Infer<typeof config>;

export const domainsDeleteCommand = Command.make("delete", config).pipe(
  Command.withDescription("Deletes the custom hostname config for your project."),
  Command.withShortDescription("Delete the custom hostname config"),
  Command.withExamples([
    {
      command: "supabase domains delete --project-ref abcdefghijklmnopqrst",
      description: "Delete the custom hostname config for a project",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-Delete hostname config", kind: "required" }],
        noApiEffectFlags: ["include-raw-output"],
      },
      projectRefPicker,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    domainsDelete(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["domains", "delete"])),
);
