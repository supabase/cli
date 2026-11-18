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
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { cliFlag, makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  ...projectTargetFlags(),
  customHostname: cliFlag("custom-hostname", Flag.String, {
    description: "The custom hostname to use for the project.",
    required: true,
  }),
  // Kept parsed (and hidden) only so using it produces the removal error instead of an
  // unknown-flag parse error.
  includeRawOutput: cliFlag("include-raw-output", Flag.Boolean, {
    description: "Removed: use -o json instead.",
    optional: true,
    hidden: true,
  }),
} as const;

const COMMAND_PATH = ["domains", "create"];
const managementApiLayer = managementApiRuntimeLayer(COMMAND_PATH);

export type DomainsCreateFlags = CliCommand.Command.Config.Infer<typeof config>;

export const domainsCreateCommand = makeCommand("create", config).pipe(
  Command.withDescription(
    "Starts custom domain setup for your project. Before you run it, add a CNAME record from your hostname to your project's Supabase subdomain. Then run `supabase domains reverify` until verification completes, and `supabase domains activate` to switch over.",
  ),
  Command.withShortDescription("Create a custom hostname"),
  Command.withExamples([
    {
      command:
        "supabase domains create --custom-hostname example.com --remote=abcdefghijklmnopqrst",
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
      branchResolution,
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
  withTargetPolicy({ group: "hosted", consent: "yes" }),
);
