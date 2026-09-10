import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { requireExperimental } from "../../../command-internal/experimental-gate.ts";
import { RESOURCE_OUTPUT_FORMATS } from "../../../command-internal/go-output-flag.ts";
import { managementApiRuntimeLayer } from "../../../command-internal/management-api-runtime.layer.ts";
import { stringSliceFlag } from "../../../command-internal/string-slice-flag.ts";
import {
  validateOutputFormat,
  withCommandTelemetry,
} from "../../../telemetry/command-telemetry.ts";
import { networkBansRemove } from "./remove.handler.ts";

/**
 * CSV-splits each occurrence (`--db-unban-ip=1.2.3.4,5.6.7.8` → two IPs) and appends across
 * repeats, failing at parse time with pflag's diagnostic on malformed CSV. If `-o` is also
 * invalid, this error wins since `-o` is validated later, in the handler.
 */
export const networkBansRemoveDbUnbanIpFlag = stringSliceFlag(
  "db-unban-ip",
  "IP to allow DB connections from.",
);

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
  dbUnbanIp: networkBansRemoveDbUnbanIpFlag,
} as const;

export type NetworkBansRemoveFlags = CliCommand.Command.Config.Infer<typeof config>;

export const networkBansRemoveCommand = Command.make("remove", config).pipe(
  Command.withDescription("Remove a network ban."),
  Command.withShortDescription("Remove a network ban"),
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
);
