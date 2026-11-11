import { Effect, Option, Ref } from "effect";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { iterateStoragePaths, iterateStoragePathsAll } from "../storage.iterate.ts";
import {
  assertStorageWorkdir,
  connectStorageGateway,
  loadStorageConfig,
  parseStorageUrlEffect,
  resolveStorageTarget,
} from "../storage.frame.ts";
import type { StorageLsFlags } from "./ls.command.ts";

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

  const linkedRef = yield* Ref.make(Option.none<string>());

  yield* Effect.gen(function* () {
    yield* assertStorageWorkdir(cliSettings.workdir);

    const { projectRef } = yield* resolveStorageTarget(flags);
    if (projectRef !== "") {
      yield* Ref.set(linkedRef, Option.some(projectRef));
    }

    // Config is always loaded; a `[remotes.*]` match prints the override line.
    const loaded = yield* loadStorageConfig(cliSettings, projectRef);
    if (loaded.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${loaded.appliedRemote}]\n`, "stderr");
    }

    // Parse the URL before building the client, so an invalid URL fails before any
    // api-keys lookup or Storage call.
    const remotePath = yield* parseStorageUrlEffect(Option.getOrElse(flags.path, () => "ss:///"));

    const paths: Array<string> = [];
    let count = 0;
    const callback = (objectPath: string) =>
      Effect.suspend(() => {
        count++;
        return output.format === "text"
          ? output.raw(`${objectPath}\n`, "stdout")
          : Effect.sync(() => {
              paths.push(objectPath);
            });
      });

    yield* connectStorageGateway(
      { projectRef, config: loaded.config, userAgent: cliSettings.userAgent },
      (gateway) =>
        flags.recursive
          ? iterateStoragePathsAll(gateway, output, remotePath, callback)
          : iterateStoragePaths(gateway, output, remotePath, callback),
    );

    yield* Effect.annotateCurrentSpan({ "file.count": count });

    if (output.format !== "text") {
      yield* output.success("", { paths });
    }
  }).pipe(
    Effect.ensuring(
      Ref.get(linkedRef).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (ref) => linkedProjectCache.cache(ref),
          }),
        ),
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
