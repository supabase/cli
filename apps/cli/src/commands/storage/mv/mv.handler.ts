import * as nodePath from "node:path";

import { Effect, Option } from "effect";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import type { StorageGateway } from "../../../command-internal/storage-gateway.ts";
import { StorageGatewayStatusError } from "../../../command-internal/storage-gateway.errors.ts";
import { splitBucketPrefix } from "../../../command-internal/storage-url.ts";
import {
  assertStorageWorkdir,
  connectStorageGateway,
  loadStorageConfig,
  parseStorageUrlEffect,
} from "../storage.frame.ts";
import {
  StorageMissingPathError,
  StorageMutuallyExclusiveFlagsError,
  StorageObjectNotFoundError,
  StorageUnsupportedMoveError,
} from "../storage.errors.ts";
import { listStoragePaths } from "../storage.iterate.ts";
import type { StorageMvFlags } from "./mv.command.ts";

/**
 * `supabase storage mv <src> <dst>` — move objects within a bucket. Both
 * paths must be `ss://` and in the same bucket. A direct move that returns
 * `not_found` falls back to a recursive per-object move when `--recursive`
 * is set.
 */
export const storageMv = Effect.fn("storage.mv")(function* (flags: StorageMvFlags) {
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const linkedProjectCache = yield* LinkedProjectCache;
  const resolver = yield* ProjectRefResolver;

  let linkedRef = "";

  yield* Effect.gen(function* () {
    yield* assertStorageWorkdir(cliSettings.workdir);

    // `--project-ref` only applies to the linked project; it never implies `--linked`.
    if (Option.isSome(flags.projectRef) && flags.local) {
      return yield* Effect.fail(
        new StorageMutuallyExclusiveFlagsError({
          message:
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local)",
        }),
      );
    }

    const projectRef = flags.local ? "" : yield* resolver.loadProjectRef(flags.projectRef);
    linkedRef = projectRef;
    const loaded = yield* loadStorageConfig(cliSettings, projectRef);
    if (loaded.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${loaded.appliedRemote}]\n`, "stderr");
    }

    // Parse and validate both paths before building the client: both must be ss://, at
    // least one prefix non-empty, and the same bucket.
    const srcParsed = yield* parseStorageUrlEffect(flags.src);
    const dstParsed = yield* parseStorageUrlEffect(flags.dst);
    const [srcBucket, srcPrefix] = splitBucketPrefix(srcParsed);
    const [dstBucket, dstPrefix] = splitBucketPrefix(dstParsed);
    if (srcPrefix.length === 0 && dstPrefix.length === 0) {
      return yield* new StorageMissingPathError();
    }
    if (srcBucket !== dstBucket) {
      return yield* new StorageUnsupportedMoveError();
    }

    yield* connectStorageGateway(
      { projectRef, config: loaded.config, userAgent: cliSettings.userAgent },
      (gateway) =>
        Effect.gen(function* () {
          yield* output.raw(`Moving object: ${srcParsed} => ${dstParsed}\n`, "stderr");
          const result = yield* gateway.moveObject(srcBucket, srcPrefix, dstPrefix).pipe(
            Effect.map((message) => ({ moved: true, message })),
            Effect.catch((error) =>
              error instanceof StorageGatewayStatusError &&
              error.body.includes('"error":"not_found"') &&
              flags.recursive
                ? Effect.succeed({ moved: false, message: "" })
                : Effect.fail(error),
            ),
          );

          if (result.moved) {
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
 * BFS over the source tree (LIFO), moving each object with its `srcPrefix`→`dstPrefix` rewrite.
 * `srcPath` is terminated by `/`. Fails with `Object not found: <srcPath>` when nothing moved.
 */
const moveStorageObjectAll = (
  gateway: StorageGateway,
  output: typeof Output.Service,
  srcPath: string,
  dstPath: string,
) =>
  Effect.gen(function* () {
    const [, dstPrefix] = splitBucketPrefix(dstPath);
    let count = 0;
    const queue: Array<string> = [srcPath];
    while (queue.length > 0) {
      const dirPath = queue.pop();
      if (dirPath === undefined) break;
      const paths = yield* listStoragePaths(gateway, output, dirPath);
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
        const [srcBucket, srcPrefix] = splitBucketPrefix(objectPath);
        const absPath = nodePath.posix.join(dstPrefix, relPath);
        yield* output.raw(
          `Moving object: ${objectPath} => ${nodePath.posix.join(dstPath, relPath)}\n`,
          "stderr",
        );
        yield* gateway.moveObject(srcBucket, srcPrefix, absPath);
      }
    }
    if (count === 0) {
      return yield* new StorageObjectNotFoundError(srcPath);
    }
    return count;
  });
