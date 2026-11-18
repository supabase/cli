import type * as CliCommand from "effect/cli/Command";
import { Argument, Command, Flag } from "effect/cli";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { secretsSet } from "./set.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { cliArgument, cliFlag, makeCommand, repeated } from "../../../shared/cli/cli-params.ts";

const config = {
  ...projectTargetFlags(),
  envFile: cliFlag("env-file", Flag.String, {
    description: "Read secrets from a .env file.",
    optional: true,
  }),
  secrets: cliArgument("NAME=VALUE", repeated(Argument.String), {
    description: "Secret NAME=VALUE pairs to set.",
    docs: { required: true },
  }),
} as const;

export type SecretsSetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const secretsSetCommand = makeCommand("set", config).pipe(
  Command.withDescription(
    "Set one or more secrets on the linked project, from `NAME=VALUE` pairs or a `.env` file. Edge Functions read them as environment variables.\n\nThe confirmation lists the secret names, never their values. Pass `--yes` in scripts and CI.",
  ),
  Command.withShortDescription("Set secrets on the linked project"),
  Command.withExamples([
    {
      command: "supabase secrets set MY_SECRET=myvalue",
      description: "Set a secret by name and value",
    },
    {
      command: "supabase secrets set --env-file .env",
      description: "Set secrets from a .env file",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-bulk-create-secrets", kind: "required" }],
        noApiEffectFlags: ["env-file"],
      },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    secretsSet(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["secrets", "set"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(config),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
