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
import { stringSliceFlag } from "../../../command-internal/string-slice-flag.ts";
import {
  validateOutputFormat,
  withCommandTelemetry,
} from "../../../telemetry/command-telemetry.ts";
import { networkBansRemove } from "./remove.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

/**
 * CSV-splits each occurrence (`--db-unban-ip=1.2.3.4,5.6.7.8` → two IPs) and appends across
 * repeats, failing at parse time with a diagnostic on malformed CSV. If `-o` is also
 * invalid, this error wins since `-o` is validated later, in the handler.
 */
export const networkBansRemoveDbUnbanIpFlag = stringSliceFlag(
  "db-unban-ip",
  "IP to allow DB connections from.",
);

const config = {
  ...projectTargetFlags(),
  dbUnbanIp: networkBansRemoveDbUnbanIpFlag,
} as const;

export type NetworkBansRemoveFlags = CliCommand.Command.Config.Infer<typeof config>;

export const networkBansRemoveCommand = Command.make("remove", config).pipe(
  Command.withDescription("Remove a network ban."),
  Command.withShortDescription("Remove a network ban"),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-delete-network-bans", kind: "required" }],
        noApiEffectFlags: ["db-unban-ip"],
      },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    networkBansRemove(flags).pipe(withCommandTelemetry({ flags }), withJsonErrorHandling),
  ),
  Command.provide(managementApiRuntimeLayer(["network-bans", "remove"])),
  withStage({ stage: "experimental" }),
  // Runs before the gate, so an invalid -o is reported even without --experimental.
  Command.provideEffectDiscard(validateOutputFormat(RESOURCE_OUTPUT_FORMATS)),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
