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
    Effect.gen(function* () {
      // Validate the -o value before the --experimental gate, so an invalid value is
      // reported even without --experimental set.
      yield* validateOutputFormat(RESOURCE_OUTPUT_FORMATS);
      // managementApiRuntimeLayer eagerly resolves an access token, so it's provided here
      // (after the gate) rather than via Command.provide, which would build it — and fail
      // on a missing token — before this generator's first yield* runs.
      yield* requireExperimental;
      return yield* networkBansGet(flags).pipe(
        withCommandTelemetry({ flags }),
        Effect.provide(managementApiRuntimeLayer(["network-bans", "get"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
