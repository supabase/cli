import { Command } from "effect/cli";

import {
  type ContractInput,
  withContract,
} from "../../../command-internal/command-contract/command-contract.annotation.ts";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { secretsSetContract } from "./set.contract.ts";
import { secretsSet } from "./set.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

export type SecretsSetFlags = ContractInput<typeof secretsSetContract>;

export const secretsSetCommand = Command.make("set", secretsSetContract.input).pipe(
  Command.withDescription("Set a secret(s) to the linked Supabase project."),
  Command.withShortDescription("Set a secret(s) on Supabase"),
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
  withCliConfigFlags(secretsSetContract.input),
  withTargetPolicy({ group: "hosted", consent: "no" }),
  withContract(secretsSetContract),
);
