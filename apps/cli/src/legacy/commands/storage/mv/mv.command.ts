import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { withLegacyCommandInstrumentation } from "../../../telemetry/legacy-command-instrumentation.ts";
import { legacyRequireExperimental } from "../../../shared/legacy-experimental-gate.ts";
import { legacyStorageGatewayRuntimeLayer } from "../../../shared/legacy-storage-runtime.layer.ts";
import {
  LegacyStorageLinkedFlagDef,
  LegacyStorageLocalFlagDef,
  legacyAssertStorageTargetsExclusive,
} from "../storage.flags.ts";
import { legacyStorageMv } from "./mv.handler.ts";

const config = {
  src: Argument.string("src").pipe(Argument.withDescription("Source path to move from.")),
  dst: Argument.string("dst").pipe(Argument.withDescription("Destination path to move to.")),
  recursive: Flag.boolean("recursive").pipe(
    Flag.withAlias("r"),
    Flag.withDescription("Recursively move a directory."),
  ),
  linked: LegacyStorageLinkedFlagDef,
  local: LegacyStorageLocalFlagDef,
} as const;

export type LegacyStorageMvFlags = CliCommand.Command.Config.Infer<typeof config>;

export const legacyStorageMvCommand = Command.make("mv", config).pipe(
  Command.withDescription("Move objects from src to dst path."),
  Command.withShortDescription("Move objects from src to dst path"),
  Command.withExamples([
    {
      command: "supabase storage mv -r ss:///bucket/docs ss:///bucket/www/docs",
      description: "Recursively move a directory within storage",
    },
  ]),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // Gate before the mutex check below — order matters; see
      // legacyRequireExperimental's doc comment for why.
      yield* legacyRequireExperimental;
      const cliArgs = yield* CliArgs;
      yield* legacyAssertStorageTargetsExclusive(cliArgs.args);
      const telemetryFlags = {
        recursive: flags.recursive,
        linked: flags.linked,
        local: flags.local,
      };
      return yield* legacyStorageMv(flags).pipe(
        withLegacyCommandInstrumentation({ flags: telemetryFlags }),
      );
    }).pipe(withJsonErrorHandling),
  ),
  Command.provide(legacyStorageGatewayRuntimeLayer(["storage", "mv"])),
);
