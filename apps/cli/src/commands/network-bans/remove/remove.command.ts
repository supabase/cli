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

// Go declares `--db-unban-ip` with pflag's `StringSliceVar` (`cmd/bans.go:48`),
// which CSV-splits each occurrence (`--db-unban-ip=1.2.3.4,5.6.7.8` → two IPs)
// and appends across repeats. Malformed CSV fails at parse time with pflag's
// exact diagnostic (see `stringSliceFlag`). Accepted approximation:
// given an invalid `-o` AND malformed CSV together, Go fails on whichever bad
// flag comes first in argv (pflag parses left-to-right); here the CSV error
// always wins, because the global `-o` is validated in-handler
// (`validateOutputFormat`) — same divergence class as the `-o` vs
// `--experimental` ordering note in the handler below.
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
      // Cobra parses flags — rejecting an out-of-enum `-o` (`internal/utils/enum.go:21-27`)
      // — before `PersistentPreRunE` ever runs (`cobra@v1.10.2/command.go:919,985`), so an
      // invalid `-o` value must win over a missing `--experimental` flag.
      yield* validateOutputFormat(RESOURCE_OUTPUT_FORMATS);
      // Go gates `bansCmd` (network-bans) behind `--experimental` in PersistentPreRunE
      // (root.go:91-96) BEFORE the `IsManagementAPI` login check (root.go:105-109).
      // `managementApiRuntimeLayer` eagerly resolves an access token as part
      // of building its `CommandPlatformApi` layer, so it must be provided AFTER
      // the gate (inline here) rather than via `Command.provide` on the whole
      // command — `Command.provide` would build the layer, and fail on a missing
      // token, before this generator's first `yield*` ever runs.
      yield* requireExperimental;
      return yield* networkBansRemove(flags).pipe(
        withCommandTelemetry({ flags }),
        Effect.provide(managementApiRuntimeLayer(["network-bans", "remove"])),
      );
    }).pipe(withJsonErrorHandling),
  ),
);
