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
import { vanitySubdomainsGet } from "./get.handler.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

const config = {
  ...projectTargetFlags(),
};

export type VanitySubdomainsGetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const vanitySubdomainsGetCommand = Command.make("get", config).pipe(
  Command.withDescription("Get the current vanity subdomain."),
  Command.withShortDescription("Get the current vanity subdomain"),
  withPermissions(
    compose(
      {
        operations: [{ operationId: "v1-get-vanity-subdomain-config", kind: "required" }],
      },
      projectRefPicker,
      linkedProjectCache,
      branchResolution,
    ),
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // An invalid `-o` value must win over a missing `--experimental` flag, so this
      // validation runs before the gate.
      yield* validateOutputFormat(RESOURCE_OUTPUT_FORMATS);
      // `managementApiRuntimeLayer` eagerly resolves an access token, so it's provided
      // inline after the experimental gate rather than via `Command.provide` on the
      // whole command — `Command.provide` would build the layer, and fail on a missing
      // token, before the gate ever runs.
      yield* requireExperimental;
      return yield* vanitySubdomainsGet(flags).pipe(
        withCommandTelemetry({ flags }),
        Effect.provide(managementApiRuntimeLayer(["vanity-subdomains", "get"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
  withTargetPolicy({ group: "hosted", consent: "none" }),
);
