import * as nodePath from "node:path";

import { Effect, Option } from "effect";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import type { LegacyStorageGateway } from "../../../shared/legacy-storage-gateway.ts";
import { LegacyStorageGatewayStatusError } from "../../../shared/legacy-storage-gateway.errors.ts";
import { legacySplitBucketPrefix } from "../../../shared/legacy-storage-url.ts";
import {
  legacyConnectStorageGateway,
  legacyLoadStorageConfig,
  legacyParseStorageUrlEffect,
} from "../storage.frame.ts";
import {
  LegacyStorageMissingPathError,
  LegacyStorageObjectNotFoundError,
  LegacyStorageUnsupportedMoveError,
} from "../storage.errors.ts";
import { legacyListStoragePaths } from "../storage.iterate.ts";
import type { LegacyStorageMvFlags } from "./mv.command.ts";

/**
 * `supabase storage mv <src> <dst>` — move objects within a bucket. Port of
 * `apps/cli-go/internal/storage/mv/mv.go`. Both paths must be `ss://` and in the
 * same bucket. A direct move that returns `not_found` falls back to a recursive
 * per-object move when `--recursive` is set.
 */
export const legacyStorageMv = Effect.fn("legacy.storage.mv")(function* (
  flags: LegacyStorageMvFlags,
) {
  const output = yield* Output;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const resolver = yield* LegacyProjectRefResolver;

  let linkedRef = "";

  yield* Effect.gen(function* () {
    const projectRef = flags.local ? "" : yield* resolver.loadProjectRef(Option.none());
    linkedRef = projectRef;
    const loaded = yield* legacyLoadStorageConfig(cliConfig.workdir, projectRef);
    if (loaded.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${loaded.appliedRemote}]\n`, "stderr");
    }

    // Parse + validate BEFORE building the client (Go `mv.go:24-39`): both must be
    // ss://, at least one prefix non-empty, and the same bucket.
    const srcParsed = yield* legacyParseStorageUrlEffect(flags.src);
    const dstParsed = yield* legacyParseStorageUrlEffect(flags.dst);
    const [srcBucket, srcPrefix] = legacySplitBucketPrefix(srcParsed);
    const [dstBucket, dstPrefix] = legacySplitBucketPrefix(dstParsed);
    if (srcPrefix.length === 0 && dstPrefix.length === 0) {
      return yield* new LegacyStorageMissingPathError();
    }
    if (srcBucket !== dstBucket) {
      return yield* new LegacyStorageUnsupportedMoveError();
    }

    yield* legacyConnectStorageGateway(
      { projectRef, config: loaded.config, userAgent: cliConfig.userAgent },
      (gateway) =>
        Effect.gen(function* () {
          yield* output.raw(`Moving object: ${srcParsed} => ${dstParsed}\n`, "stderr");
          const result = yield* gateway.moveObject(srcBucket, srcPrefix, dstPrefix).pipe(
            Effect.map((message) => ({ moved: true, message })),
            Effect.catch((error) =>
              error instanceof LegacyStorageGatewayStatusError &&
              error.body.includes('"error":"not_found"') &&
              flags.recursive
                ? Effect.succeed({ moved: false, message: "" })
                : Effect.fail(error),
            ),
          );

          if (result.moved) {
            // Go prints the move response message on success.
            yield* output.raw(`${result.message}\n`, "stderr");
            if (output.format !== "text") {
              yield* output.success("", { message: result.message });
            }
            return;
          }

          // Recursive fallback on `not_found`.
          const moved = yield* moveStorageObjectAll(gateway, output, `${srcParsed}/`, dstParsed);
          if (output.format !== "text") {
            yield* output.success("", { message: "", moved });
          }
        }),
    );
  }).pipe(
    Effect.ensuring(
      Effect.suspend(() => (linkedRef === "" ? Effect.void : linkedProjectCache.cache(linkedRef))),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});

/**
 * Go `MoveStorageObjectAll` (`mv.go:55-88`): BFS over the source tree (LIFO),
 * moving each object with its `srcPrefix`→`dstPrefix` rewrite. `srcPath` is
 * terminated by `/`. Fails with `Object not found: <srcPath>` when nothing moved.
 */
const moveStorageObjectAll = (
  gateway: LegacyStorageGateway,
  output: typeof Output.Service,
  srcPath: string,
  dstPath: string,
) =>
  Effect.gen(function* () {
    const [, dstPrefix] = legacySplitBucketPrefix(dstPath);
    let count = 0;
    const queue: Array<string> = [srcPath];
    while (queue.length > 0) {
      const dirPath = queue.pop();
      if (dirPath === undefined) break;
      const paths = yield* legacyListStoragePaths(gateway, output, dirPath);
      for (const objectName of paths) {
        const objectPath = dirPath + objectName;
        if (objectName.endsWith("/")) {
          queue.push(objectPath);
          continue;
        }
        count++;
        const relPath = objectPath.startsWith(srcPath)
          ? objectPath.slice(srcPath.length)
          : objectPath;
        const [srcBucket, srcPrefix] = legacySplitBucketPrefix(objectPath);
        const absPath = nodePath.posix.join(dstPrefix, relPath);
        yield* output.raw(
          `Moving object: ${objectPath} => ${nodePath.posix.join(dstPath, relPath)}\n`,
          "stderr",
        );
        yield* gateway.moveObject(srcBucket, srcPrefix, absPath);
      }
    }
    if (count === 0) {
      return yield* new LegacyStorageObjectNotFoundError(srcPath);
    }
    return count;
  });
