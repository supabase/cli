import { Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withStage } from "../../../command-internal/command-facts/with-stage.ts";
import { RESOURCE_OUTPUT_FORMATS } from "../../../command-internal/output-formats.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import {
  validateOutputFormat,
  withCommandTelemetry,
} from "../../../telemetry/command-telemetry.ts";
import { networkBansGet } from "./get.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  ...projectTargetFlags(),
};

export type NetworkBansGetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const networkBansGetCommand = Command.make("get", config).pipe(
  Command.withDescription("Get the current network bans."),
  Command.withShortDescription("Get the current network bans"),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-list-all-network-bans", kind: "required" }],
      },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    networkBansGet(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["network-bans", "get"])),
  withStage({ stage: "experimental" }),
  // Runs before the gate, so an invalid -o is reported even without --experimental.
  Command.provideEffectDiscard(validateOutputFormat(RESOURCE_OUTPUT_FORMATS)),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
