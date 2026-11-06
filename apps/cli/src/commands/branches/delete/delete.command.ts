import { Command } from "effect/cli";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { branchPrompt } from "../branches.prompt.ts";
import { branchRef } from "../../../command-internal/branch-ref.resolver.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import {
  type ContractInput,
  withContract,
} from "../../../command-internal/command-contract/command-contract.annotation.ts";
import { branchesDeleteContract } from "./delete.contract.ts";
import { branchesDelete } from "./delete.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { branchesParentTarget } from "../branches.target.ts";

export type BranchesDeleteFlags = ContractInput<typeof branchesDeleteContract>;

export const branchesDeleteCommand = Command.make("delete", branchesDeleteContract.input).pipe(
  Command.withDescription("Delete a preview branch by its name or ID."),
  Command.withShortDescription("Delete a preview branch"),
  withPermissions(
    compose(
      { operations: [{ operationId: "v1-delete-a-branch", kind: "required" }] },
      branchesParentTarget,
      projectRefPicker,
      branchPrompt,
      branchRef,
      linkedProjectCache,
    ),
  ),
  Command.withHandler((flags) =>
    branchesDelete(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["branches", "delete"])),
  withTargetPolicy({ group: "hosted", consent: "no" }),
  withContract(branchesDeleteContract),
);
