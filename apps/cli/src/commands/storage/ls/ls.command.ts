import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type * as CliCommand from "effect/unstable/cli/Command";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../telemetry/command-telemetry.ts";
import { requireExperimental } from "../../../command-internal/experimental-gate.ts";
import { storageGatewayRuntimeLayer } from "../../../command-internal/storage-runtime.layer.ts";
import {
  StorageLinkedFlagDef,
  StorageLocalFlagDef,
  StorageProjectRefFlagDef,
  assertStorageTargetsExclusive,
} from "../storage.flags.ts";
import { storageLs } from "./ls.handler.ts";

const config = {
  path: Argument.string("path").pipe(
    Argument.withDescription("Storage path to list (e.g. ss:///bucket/docs)."),
    Argument.optional,
  ),
  recursive: Flag.boolean("recursive").pipe(
    Flag.withAlias("r"),
    Flag.withDescription("Recursively list a directory."),
    Flag.withDefault(false),
  ),
  linked: StorageLinkedFlagDef,
  local: StorageLocalFlagDef,
  projectRef: StorageProjectRefFlagDef,
} as const;

export type StorageLsFlags = CliCommand.Command.Config.Infer<typeof config>;

export const storageLsCommand = Command.make("ls", config).pipe(
  Command.withDescription("List objects by path prefix."),
  Command.withShortDescription("List objects by path prefix"),
  Command.withExamples([
    {
      command: "supabase storage ls ss:///bucket/docs",
      description: "List objects at a storage path",
    },
  ]),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // Gate before the mutex check below — order matters; see
      // requireExperimental's doc comment for why.
      yield* requireExperimental;
      const cliArgs = yield* CliArgs;
      yield* assertStorageTargetsExclusive(cliArgs.args);
      const telemetryFlags = {
        recursive: flags.recursive,
        linked: flags.linked,
        local: flags.local,
        "project-ref": flags.projectRef,
      };
      return yield* storageLs(flags).pipe(
        // TS-only flag with no Go telemetry-safety baseline; Go's nearest
        // --project-ref registrations (cmd/pgdelta_catalog.go:44 and most
        // others) are unmarked, so it stays redacted.
        withCommandTelemetry({ flags: telemetryFlags }),
      );
    }).pipe(withJsonErrorHandling),
  ),
  Command.provide(storageGatewayRuntimeLayer(["storage", "ls"])),
);
