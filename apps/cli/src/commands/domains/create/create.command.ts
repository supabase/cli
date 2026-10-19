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
import { domainsCreate } from "./create.handler.ts";

const config = {
  projectRef: Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  customHostname: Flag.String("custom-hostname").pipe(
    Flag.withDescription("The custom hostname to use for your Supabase project."),
  ),
  // Kept parsed (and hidden) only so using it produces the removal error instead of an
  // unknown-flag parse error.
  includeRawOutput: Flag.Boolean("include-raw-output").pipe(
    Flag.withDescription("Removed: use -o json instead."),
    Flag.optional,
    Flag.withHidden,
  ),
} as const;

const COMMAND_PATH = ["domains", "create"];
const managementApiLayer = managementApiRuntimeLayer(COMMAND_PATH);

export type DomainsCreateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const domainsCreateCommand = Command.make("create", config).pipe(
  Command.withDescription(
    "Create a custom hostname for your Supabase project. Expects your custom hostname to have a CNAME record to your Supabase project's subdomain.",
  ),
  Command.withShortDescription("Create a custom hostname"),
  Command.withExamples([
    {
      command:
        "supabase domains create --custom-hostname example.com --project-ref abcdefghijklmnopqrst",
      description: "Create a custom hostname for a project",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-update-hostname-config", kind: "required" }],
        noApiEffectFlags: ["custom-hostname", "include-raw-output"],
      },
      projectRefPicker,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    Option.isSome(flags.includeRawOutput)
      ? rejectIncludeRawOutput(COMMAND_PATH, flags)
      : domainsCreate(flags).pipe(
          withCommandTelemetry({ flags }),
          withJsonErrorHandling,
          Effect.provide(managementApiLayer),
        ),
  ),
);
