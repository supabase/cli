import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { legacyRequireExperimental } from "../../../shared/legacy-experimental-gate.ts";
import { legacyManagementApiRuntimeLayer } from "../../../shared/legacy-management-api-runtime.layer.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyNetworkBansGet } from "./get.handler.ts";

const config = {
  projectRef: Flag.string("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project."),
    Flag.optional,
  ),
};

export type LegacyNetworkBansGetFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyNetworkBansGetCommand = Command.make("get", config).pipe(
  Command.withDescription("Get the current network bans."),
  Command.withShortDescription("Get the current network bans"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // Go gates `bansCmd` (network-bans) behind `--experimental` in PersistentPreRunE
      // (root.go:91-96) BEFORE the `IsManagementAPI` login check (root.go:105-109).
      // `legacyManagementApiRuntimeLayer` eagerly resolves an access token as part
      // of building its `LegacyPlatformApi` layer, so it must be provided AFTER
      // the gate (inline here) rather than via `Command.provide` on the whole
      // command — `Command.provide` would build the layer, and fail on a missing
      // token, before this generator's first `yield*` ever runs.
      yield* legacyRequireExperimental;
      return yield* legacyNetworkBansGet(flags).pipe(
        withLegacyCommandInstrumentation({ flags }),
        Effect.provide(legacyManagementApiRuntimeLayer(["network-bans", "get"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
);
