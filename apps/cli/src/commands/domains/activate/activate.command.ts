import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { rejectIncludeRawOutput } from "../domains.removed-flag.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { domainsActivate } from "./activate.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  // Kept parsed (and hidden) only so using it produces the removal error instead of an
  // unknown-flag parse error.
  includeRawOutput: Flag.Boolean("include-raw-output").pipe(
    Flag.withDescription("Removed: use -o json instead."),
    Flag.optional,
    Flag.withHidden,
  ),
} as const;

const COMMAND_PATH = ["domains", "activate"];
const managementApiLayer = managementApiRuntimeLayer(COMMAND_PATH);

export type DomainsActivateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const domainsActivateCommand = Command.make("activate", config).pipe(
  Command.withDescription(
    "Activates the custom hostname configuration for a project. This reconfigures your Supabase project to respond to requests on your custom hostname. After the custom hostname is activated, your project's auth services will no longer function on the Supabase-provisioned subdomain.",
  ),
  Command.withShortDescription("Activate the custom hostname for a project"),
  Command.withExamples([
    {
      command: "supabase domains activate --project-ref abcdefghijklmnopqrst",
      description: "Activate the custom hostname for a project",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-activate-custom-hostname", kind: "required" }],
        noApiEffectFlags: ["include-raw-output"],
      },
      projectRefPicker,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    Option.isSome(flags.includeRawOutput)
      ? rejectIncludeRawOutput(COMMAND_PATH, flags)
      : domainsActivate(flags).pipe(
          withCommandTelemetry({ flags }),
          withJsonErrorHandling,
          Effect.provide(managementApiLayer),
        ),
  ),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
