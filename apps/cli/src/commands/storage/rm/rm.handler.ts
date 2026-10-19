import { Effect, FileSystem, Option, Path, Ref } from "effect";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { resolveYesWithProjectEnv } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { bold } from "../../../command-internal/colors.ts";
import { loadProjectEnvValues } from "../../../command-internal/db-config.toml-read.ts";
import { requireTargetMutationConsent } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import type { HostedMutationConsent } from "../../../command-internal/hosted-consent/hosted-consent.token.ts";
import { promptYesNo } from "../../../command-internal/prompt-yes-no.ts";
import {
  DELETE_OBJECTS_LIMIT,
  type StorageGateway,
} from "../../../command-internal/storage-gateway.ts";
import { splitBucketPrefix, storageIsDir } from "../../../command-internal/storage-url.ts";
import type { RemoteValue } from "../../../command-internal/target/remote-value.ts";
import {
  assertStorageWorkdir,
  connectStorageGateway,
  loadStorageConfig,
  parseStorageUrlEffect,
  resolveStorageTarget,
} from "../storage.frame.ts";
import {
  StorageMissingBucketError,
  StorageMissingFlagError,
  StorageObjectNotFoundError,
  StorageRmConfirmationRequiredError,
} from "../storage.errors.ts";
import { listStoragePaths } from "../storage.iterate.ts";

export interface StorageRmFlags {
  readonly files: ReadonlyArray<string>;
  readonly recursive: boolean;
  readonly remote: Option.Option<RemoteValue>;
  readonly linked: boolean;
  readonly local: boolean;
  readonly projectRef: Option.Option<string>;
}

interface RmSummary {
  readonly deleted: Array<string>;
  readonly buckets_deleted: Array<string>;
}

/**
 * `supabase storage rm <file>...` — remove objects by path. Paths are
 * grouped by bucket; each bucket is confirmed, its explicit prefixes are
 * deleted (chunked at 1000), and any prefix that resolved to a directory is
 * removed recursively when `-r` is set.
 */
export const storageRm = Effect.fn("storage.rm")(function* (flags: StorageRmFlags) {
  const output = yield* Output;
  const cliSettings = yield* CommandSettings;
  const telemetryState = yield* TelemetryState;
  const linkedProjectCache = yield* LinkedProjectCache;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const linkedRef = yield* Ref.make(Option.none<string>());

  yield* Effect.gen(function* () {
    yield* assertStorageWorkdir(cliSettings.workdir);

    const { target, projectRef } = yield* resolveStorageTarget(flags);
    if (projectRef !== "") {
      yield* Ref.set(linkedRef, Option.some(projectRef));
    }
    // Only the local per-bucket prompt honours a project `.env` `SUPABASE_YES`; loaded after the
    // target so an unlinked workdir fails as not linked, not as an env-parse error.
    const localYes =
      target.kind === "local"
        ? yield* resolveYesWithProjectEnv(
            yield* loadProjectEnvValues(fs, path, cliSettings.workdir),
          )
        : false;
    const loaded = yield* loadStorageConfig(cliSettings, projectRef);
    if (loaded.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${loaded.appliedRemote}]\n`, "stderr");
    }

    const groups = new Map<string, Array<string>>();
    for (const objectPath of flags.files) {
      const remotePath = yield* parseStorageUrlEffect(objectPath);
      const [bucket, prefix] = splitBucketPrefix(remotePath);
      if (bucket.length === 0) {
        return yield* new StorageMissingBucketError();
      }
      if (storageIsDir(prefix) && !flags.recursive) {
        return yield* new StorageMissingFlagError();
      }
      const existing = groups.get(bucket);
      if (existing === undefined) groups.set(bucket, [prefix]);
      else existing.push(prefix);
    }

    // No paths and no `-r` falls through to the missing-`-r` failure below.
    const missingRecursive = groups.size === 0 && !flags.recursive;
    if (target.kind === "local" && !localYes && !missingRecursive && output.format !== "text") {
      return yield* new StorageRmConfirmationRequiredError();
    }

    const summary: RmSummary = { deleted: [], buckets_deleted: [] };

    yield* connectStorageGateway(
      { projectRef, config: loaded.config, userAgent: cliSettings.userAgent },
      (gateway) =>
        Effect.gen(function* () {
          // No paths given: `-r` deletes every bucket, otherwise it's a missing-flag error.
          if (groups.size === 0) {
            if (!flags.recursive) {
              return yield* new StorageMissingFlagError();
            }
            const buckets = yield* gateway.listBuckets;
            for (const b of buckets) groups.set(b.name, [""]);
          }

          const consent =
            groups.size === 0
              ? Option.none<HostedMutationConsent>()
              : yield* requireTargetMutationConsent(target, {
                  action: `Delete objects in ${groups.size} bucket${groups.size === 1 ? "" : "s"}`,
                  details: [...groups].map(
                    ([bucket, prefixes]) =>
                      `Delete from ${bucket}: ${prefixes.map(describePrefix).join(", ")}`,
                  ),
                });

          for (const [bucket, prefixes] of groups) {
            const shouldDelete = Option.isSome(consent)
              ? true
              : yield* promptYesNo(
                  output,
                  localYes,
                  `Confirm deleting files in bucket ${bold(bucket)}?`,
                  false,
                );
            if (!shouldDelete) continue;

            // Always try deleting first in case the paths are extensionless files.
            yield* output.raw(`Deleting objects: [${prefixes.join(" ")}]\n`, "stderr");
            const removed = yield* deleteObjects(gateway, bucket, prefixes, summary);
            const removedSet = new Set(removed.map((o) => o.name));

            for (const prefix of prefixes) {
              if (removedSet.has(prefix)) continue;
              if (!flags.recursive) {
                yield* output.raw(`Object not found: ${prefix}\n`, "stderr");
                continue;
              }
              const dirPrefix = prefix.length > 0 ? `${prefix}/` : prefix;
              yield* removeStoragePathAll(gateway, output, bucket, dirPrefix, summary);
            }
          }

          yield* Effect.annotateCurrentSpan({
            "bucket.count": groups.size,
            "file.count": summary.deleted.length,
            "bucket.deleted_count": summary.buckets_deleted.length,
          });

          if (output.format !== "text") {
            yield* output.success("", {
              deleted: summary.deleted,
              buckets_deleted: summary.buckets_deleted,
            });
          }
        }),
    );
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

const describePrefix = (prefix: string): string =>
  prefix === "" ? "every object and the bucket itself" : prefix;

/** Deletes objects in chunks of DELETE_OBJECTS_LIMIT. */
const deleteObjects = (
  gateway: StorageGateway,
  bucket: string,
  prefixes: ReadonlyArray<string>,
  summary: RmSummary,
) =>
  Effect.gen(function* () {
    const removed: Array<{ name: string }> = [];
    for (let start = 0; start < prefixes.length; start += DELETE_OBJECTS_LIMIT) {
      const end = Math.min(start + DELETE_OBJECTS_LIMIT, prefixes.length);
      const objects = yield* gateway.deleteObjects(bucket, prefixes.slice(start, end));
      removed.push(...objects);
    }
    for (const o of removed) summary.deleted.push(o.name);
    return removed;
  });

/**
 * Walks the prefix tree with a stack, deleting files per directory, then the bucket
 * itself once the prefix is empty. `prefix` ends with `/` or is empty.
 */
const removeStoragePathAll = Effect.fn("storage.rm.removeAll")(function* (
  gateway: StorageGateway,
  output: typeof Output.Service,
  bucket: string,
  prefix: string,
  summary: RmSummary,
) {
  let deletedCount = 0;
  const queue: Array<string> = [prefix];
  while (queue.length > 0) {
    const dirPrefix = queue.pop();
    if (dirPrefix === undefined) break;
    const paths = yield* listStoragePaths(gateway, output, `/${bucket}/${dirPrefix}`);
    if (paths.length === 0 && prefix.length > 0) {
      return yield* new StorageObjectNotFoundError(`${bucket}/${prefix}`);
    }
    const files: Array<string> = [];
    for (const objectName of paths) {
      const objectPrefix = dirPrefix + objectName;
      if (objectName.endsWith("/")) {
        queue.push(objectPrefix);
      } else {
        files.push(objectPrefix);
      }
    }
    if (files.length > 0) {
      yield* output.raw(`Deleting objects: [${files.join(" ")}]\n`, "stderr");
      yield* deleteObjects(gateway, bucket, files, summary);
      deletedCount += files.length;
    }
  }
  yield* Effect.annotateCurrentSpan({ "file.count": deletedCount });
  if (prefix.length === 0) {
    yield* output.raw(`Deleting bucket: ${bucket}\n`, "stderr");
    yield* gateway.deleteBucket(bucket).pipe(
      Effect.flatMap((message) =>
        Effect.gen(function* () {
          yield* output.raw(`${message}\n`, "stderr");
          summary.buckets_deleted.push(bucket);
        }),
      ),
      Effect.catchTag("StorageGatewayStatusError", (error) =>
        error.body.includes('"error":"Bucket not found"')
          ? output.raw(`Bucket not found: ${bucket}\n`, "stderr")
          : Effect.fail(error),
      ),
    );
  }
});
