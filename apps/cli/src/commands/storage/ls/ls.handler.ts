import { Effect, Option } from "effect";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { iterateStoragePaths, iterateStoragePathsAll } from "../storage.iterate.ts";
import {
  assertStorageWorkdir,
  connectStorageGateway,
  loadStorageConfig,
  parseStorageUrlEffect,
} from "../storage.frame.ts";
import type { StorageLsFlags } from "./ls.command.ts";
import { StorageMutuallyExclusiveFlagsError } from "../storage.errors.ts";

/**
 * `supabase storage ls [path]` — list objects by path prefix.
 *
 * The default path is `ss:///` (all buckets); `--recursive` walks the tree
 * with BFS. Text mode prints one entry per line to **stdout**;
 * json/stream-json emit a single `{ paths }` result.
 */
export const storageLs = Effect.fn("storage.ls")(function* (flags: StorageLsFlags) {
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const linkedProjectCache = yield* LinkedProjectCache;
  const resolver = yield* ProjectRefResolver;

  let linkedRef = "";

  yield* Effect.gen(function* () {
    yield* assertStorageWorkdir(cliSettings.workdir);

    // `--project-ref` never implies `--linked` and must not be silently
    // discarded on the local target — see push.handler.ts's identical guard
    // (db push) for the full TS-only rationale.
    if (Option.isSome(flags.projectRef) && flags.local) {
      return yield* Effect.fail(
        new StorageMutuallyExclusiveFlagsError({
          message:
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local)",
        }),
      );
    }

    // Routing reads the `--local` value (Go `storage.go:21-32`): local clears the
    // ref, otherwise the linked path resolves it. No network — safe before the
    // url parse below.
    const projectRef = flags.local ? "" : yield* resolver.loadProjectRef(flags.projectRef);
    linkedRef = projectRef;

    // Config is always loaded; a `[remotes.*]` match prints the override
    // line.
    const loaded = yield* loadStorageConfig(cliSettings, projectRef);
    if (loaded.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${loaded.appliedRemote}]\n`, "stderr");
    }

    // Parse the URL BEFORE building the client (Go `ls.go:17`), so an invalid URL
    // fails without an api-keys lookup or any Storage call.
    const remotePath = yield* parseStorageUrlEffect(Option.getOrElse(flags.path, () => "ss:///"));

    const paths: Array<string> = [];
    const callback = (objectPath: string) =>
      output.format === "text"
        ? output.raw(`${objectPath}\n`, "stdout")
        : Effect.sync(() => {
            paths.push(objectPath);
          });

    yield* connectStorageGateway(
      { projectRef, config: loaded.config, userAgent: cliSettings.userAgent },
      (gateway) =>
        flags.recursive
          ? iterateStoragePathsAll(gateway, output, remotePath, callback)
          : iterateStoragePaths(gateway, output, remotePath, callback),
    );

    if (output.format !== "text") {
      yield* output.success("", { paths });
    }
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() => (linkedRef === "" ? Effect.void : linkedProjectCache.cache(linkedRef))),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
