import { Effect } from "effect";
import { Command } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../../command-internal/target/target-flags.ts";
import { projectRefPicker } from "../../../config/project-ref.layer.ts";
import { linkedProjectCache } from "../../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { requireExperimental } from "../../../command-internal/experimental-gate.ts";
import { RESOURCE_OUTPUT_FORMATS } from "../../../command-internal/output-formats.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { stringSliceFlag } from "../../../command-internal/string-slice-flag.ts";
import {
  validateOutputFormat,
  withCommandTelemetry,
} from "../../../telemetry/command-telemetry.ts";
import { networkBansRemove } from "./remove.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { makeCommand } from "../../../shared/cli/cli-params.ts";

/**
 * CSV-splits each occurrence (`--db-unban-ip=1.2.3.4,5.6.7.8` → two IPs) and appends across
 * repeats, failing at parse time with a diagnostic on malformed CSV. If `-o` is also
 * invalid, this error wins since `-o` is validated later, in the handler.
 */
export const networkBansRemoveDbUnbanIpFlag = stringSliceFlag(
  "db-unban-ip",
  "IP address to unblock, comma-separated or repeated.",
);

const config = {
  ...projectTargetFlags(),
  dbUnbanIp: networkBansRemoveDbUnbanIpFlag,
} as const;

export type NetworkBansRemoveFlags = CliCommand.Command.Config.Infer<typeof config>;

export const networkBansRemoveCommand = makeCommand("remove", config).pipe(
  Command.withDescription("Unblocks banned IP addresses. If you pass no IP, it unblocks the IP address of the machine you run it from."),
  Command.withShortDescription("Remove a network ban"),
  Command.withExamples([
    {
      command: "supabase network-bans remove --db-unban-ip 203.0.113.7 --experimental --remote=<project-ref>",
      description: "Unban a single IP address",
    },
    {
      command: "supabase network-bans remove --experimental --remote=<project-ref>",
      description: "Unban the IP address of this machine",
    },
  ]),
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
    Effect.gen(function* () {
      // Validate the -o value before the --experimental gate, so an invalid value is
      // reported even without --experimental set.
      yield* validateOutputFormat(RESOURCE_OUTPUT_FORMATS);
      // managementApiRuntimeLayer eagerly resolves an access token, so it's provided here
      // (after the gate) rather than via Command.provide, which would build it — and fail
      // on a missing token — before this generator's first yield* runs.
      yield* requireExperimental;
      return yield* networkBansRemove(flags).pipe(
        withCommandTelemetry({ flags }),
        Effect.provide(managementApiRuntimeLayer(["network-bans", "remove"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
  withTargetPolicy({ group: "hosted", consent: "no" }),
);
