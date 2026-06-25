import { Effect, Option } from "effect";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { legacyIterateStoragePaths, legacyIterateStoragePathsAll } from "../storage.iterate.ts";
import {
  legacyConnectStorageGateway,
  legacyLoadStorageConfig,
  legacyParseStorageUrlEffect,
} from "../storage.frame.ts";
import type { LegacyStorageLsFlags } from "./ls.command.ts";

/**
 * `supabase storage ls [path]` — list objects by path prefix.
 *
 * Port of `apps/cli-go/internal/storage/ls/ls.go`. The default path is `ss:///`
 * (all buckets); `--recursive` walks the tree with BFS. Text mode prints one
 * entry per line to **stdout** (Go `fmt.Println`); json/stream-json emit a single
 * `{ paths }` result.
 */
export const legacyStorageLs = Effect.fn("legacy.storage.ls")(function* (
  flags: LegacyStorageLsFlags,
) {
  const output = yield* Output;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const resolver = yield* LegacyProjectRefResolver;

  let linkedRef = "";

  yield* Effect.gen(function* () {
    // Routing reads the `--local` value (Go `storage.go:21-32`): local clears the
    // ref, otherwise the linked path resolves it. No network — safe before the
    // url parse below.
    const projectRef = flags.local ? "" : yield* resolver.loadProjectRef(Option.none());
    linkedRef = projectRef;

    // Config is always loaded (Go's `utils.Config`); a `[remotes.*]` match prints
    // the override line.
    const loaded = yield* legacyLoadStorageConfig(cliConfig.workdir, projectRef);
    if (loaded.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${loaded.appliedRemote}]\n`, "stderr");
    }

    // Parse the URL BEFORE building the client (Go `ls.go:17`), so an invalid URL
    // fails without an api-keys lookup or any Storage call.
    const remotePath = yield* legacyParseStorageUrlEffect(
      Option.getOrElse(flags.path, () => "ss:///"),
    );

    const paths: Array<string> = [];
    const callback = (objectPath: string) =>
      output.format === "text"
        ? output.raw(`${objectPath}\n`, "stdout")
        : Effect.sync(() => {
            paths.push(objectPath);
          });

    yield* legacyConnectStorageGateway(
      { projectRef, config: loaded.config, userAgent: cliConfig.userAgent },
      (gateway) =>
        flags.recursive
          ? legacyIterateStoragePathsAll(gateway, output, remotePath, callback)
          : legacyIterateStoragePaths(gateway, output, remotePath, callback),
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
