import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import type * as CliCommand from "effect/cli/Command";

import { withPermissions } from "../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../command-internal/command-permissions/model.ts";
import { requireExperimental } from "../../command-internal/experimental-gate.ts";
import { branchResolution } from "../../command-internal/target/branch-resolution.ts";
import { projectTargetFlags } from "../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../command-internal/target/target-policy.ts";
import { projectRefPicker } from "../../config/project-ref.layer.ts";
import { managementApiRuntimeLayer } from "../../command-internal/management-api-runtime.layer.ts";
import { linkedProjectCache } from "../../telemetry/linked-project-cache.layer.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../telemetry/command-telemetry.ts";
import { tracesGet } from "./traces.handler.ts";

const config = {
  traceId: Flag.String("trace-id").pipe(
    Flag.withDescription("The trace id to look up. Trace search is not available yet."),
    Flag.optional,
  ),
  ...projectTargetFlags(),
} as const;

export type TracesFlags = CliCommand.Command.Config.Infer<typeof config>;

export const tracesCommand = Command.make("traces", config).pipe(
  Command.withDescription(
    "Experimental: look up a trace by id and print its spans. Closed alpha; the Management API " +
      "endpoint is not in the published OpenAPI spec yet and the output may change.",
  ),
  Command.withShortDescription("Look up a trace and print its spans (experimental)"),
  withPermissions(
    // The trace-spans endpoint has no generated operationId yet (not in the OpenAPI spec), so it
    // has no entry here — see traces.api.ts.
    compose(
      { operations: [], noApiEffectFlags: ["trace-id"] },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      yield* requireExperimental;
      return yield* tracesGet(flags).pipe(
        withCommandTelemetry({ flags }),
        Effect.provide(managementApiRuntimeLayer(["traces"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
