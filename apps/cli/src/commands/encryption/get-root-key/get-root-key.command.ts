import { Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { encryptionGetRootKey } from "./get-root-key.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { makeCommand } from "../../../shared/cli/cli-params.ts";

const config = {
  ...projectTargetFlags(),
} as const;

export type EncryptionGetRootKeyFlags = CliCommand.Command.Config.Infer<typeof config>;

export const encryptionGetRootKeyCommand = makeCommand("get-root-key", config).pipe(
  Command.withDescription(
    "Print the root encryption key of the project. Treat the output as a secret.",
  ),
  Command.withShortDescription("Get the root encryption key"),
  Command.withExamples([
    {
      command: "supabase encryption get-root-key",
      description: "Print the root encryption key of the linked project",
    },
  ]),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-get-pgsodium-config", kind: "required" }],
      },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    encryptionGetRootKey(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["encryption", "get-root-key"])),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
