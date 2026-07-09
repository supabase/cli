import { Effect, FileSystem, Option, Path } from "effect";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { legacyResolveYesWithProjectEnv } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { legacyBold } from "../../../shared/legacy-colors.ts";
import { legacyLoadProjectEnv } from "../../../shared/legacy-db-config.toml-read.ts";
import { legacyPromptYesNo } from "../../../shared/legacy-prompt-yes-no.ts";
import {
  LEGACY_DELETE_OBJECTS_LIMIT,
  type LegacyStorageGateway,
} from "../../../shared/legacy-storage-gateway.ts";
import { LegacyStorageGatewayStatusError } from "../../../shared/legacy-storage-gateway.errors.ts";
import { legacySplitBucketPrefix, legacyStorageIsDir } from "../../../shared/legacy-storage-url.ts";
import {
  legacyConnectStorageGateway,
  legacyLoadStorageConfig,
  legacyParseStorageUrlEffect,
} from "../storage.frame.ts";
import {
  LegacyStorageMissingBucketError,
  LegacyStorageMissingFlagError,
  LegacyStorageObjectNotFoundError,
} from "../storage.errors.ts";
import { legacyListStoragePaths } from "../storage.iterate.ts";

export interface LegacyStorageRmFlags {
  readonly files: ReadonlyArray<string>;
  readonly recursive: boolean;
  // `linked` is carried for parity with the ls/cp/mv handler signatures; routing
  // reads only `local` (Go `storage.go:21-32` reads `GetBool("local")`).
  readonly linked: boolean;
  readonly local: boolean;
}

interface RmSummary {
  readonly deleted: Array<string>;
  readonly buckets_deleted: Array<string>;
}

/**
 * `supabase storage rm <file>...` — remove objects by path. Port of
 * `apps/cli-go/internal/storage/rm/rm.go`. Paths are grouped by bucket; each
 * bucket is confirmed, its explicit prefixes are deleted (chunked at 1000), and
 * any prefix that resolved to a directory is removed recursively when `-r` is set.
 */
export const legacyStorageRm = Effect.fn("legacy.storage.rm")(function* (
  flags: LegacyStorageRmFlags,
) {
  const output = yield* Output;
  const cliConfig = yield* LegacyCliConfig;
  const telemetryState = yield* LegacyTelemetryState;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const resolver = yield* LegacyProjectRefResolver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  let linkedRef = "";

  yield* Effect.gen(function* () {
    // Resolve the project ref BEFORE reading the project `.env`, matching Go's
    // `ParseDatabaseConfig` `case linked:` (`db_url.go:87-93`), which calls
    // `LoadProjectRef` strictly before `LoadConfig` (the `.env`/`loadNestedEnv`
    // work). An unlinked workdir must fail fast with the not-linked guidance
    // before a malformed/unreadable `supabase/.env` gets a chance to mask it
    // with an env-parse error.
    const projectRef = flags.local ? "" : yield* resolver.loadProjectRef(Option.none());
    linkedRef = projectRef;
    // `--yes` OR `SUPABASE_YES` (Go's viper AutomaticEnv, root.go:318-320). Both the
    // `--local` and (default) `--linked` branches of `ParseDatabaseConfig` call
    // `LoadConfig` — which loads the project `.env` files — before `rm.Run`'s
    // confirmation prompt (`root.go:118` → `db_url.go:78` (`local`) / `:91` (`linked`)),
    // so a `SUPABASE_YES` set only in `supabase/.env` must auto-confirm here too.
    const projectEnv = yield* legacyLoadProjectEnv(fs, path, cliConfig.workdir);
    const yes = yield* legacyResolveYesWithProjectEnv(projectEnv);
    const loaded = yield* legacyLoadStorageConfig(cliConfig.workdir, projectRef);
    if (loaded.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${loaded.appliedRemote}]\n`, "stderr");
    }

    // Group paths by bucket, validating BEFORE building the client (Go `rm.go:31-47`).
    const groups = new Map<string, Array<string>>();
    for (const objectPath of flags.files) {
      const remotePath = yield* legacyParseStorageUrlEffect(objectPath);
      const [bucket, prefix] = legacySplitBucketPrefix(remotePath);
      if (bucket.length === 0) {
        return yield* new LegacyStorageMissingBucketError();
      }
      if (legacyStorageIsDir(prefix) && !flags.recursive) {
        return yield* new LegacyStorageMissingFlagError();
      }
      const existing = groups.get(bucket);
      if (existing === undefined) groups.set(bucket, [prefix]);
      else existing.push(prefix);
    }

    const summary: RmSummary = { deleted: [], buckets_deleted: [] };

    yield* legacyConnectStorageGateway(
      { projectRef, config: loaded.config, userAgent: cliConfig.userAgent },
      (gateway) =>
        Effect.gen(function* () {
          // No paths: `-r` deletes every bucket, otherwise it's a missing-flag
          // error (Go `rm.go:52-63`, after the client is built).
          if (groups.size === 0) {
            if (!flags.recursive) {
              return yield* new LegacyStorageMissingFlagError();
            }
            const buckets = yield* gateway.listBuckets();
            for (const b of buckets) groups.set(b.name, [""]);
          }

          for (const [bucket, prefixes] of groups) {
            const shouldDelete = yield* legacyPromptYesNo(
              output,
              yes,
              `Confirm deleting files in bucket ${legacyBold(bucket)}?`,
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
      Effect.suspend(() => (linkedRef === "" ? Effect.void : linkedProjectCache.cache(linkedRef))),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});

/** Go `rm.deleteObjects` (`rm.go:145-156`): DELETE in chunks of DELETE_OBJECTS_LIMIT. */
const deleteObjects = (
  gateway: LegacyStorageGateway,
  bucket: string,
  prefixes: ReadonlyArray<string>,
  summary: RmSummary,
) =>
  Effect.gen(function* () {
    const removed: Array<{ name: string }> = [];
    for (let start = 0; start < prefixes.length; start += LEGACY_DELETE_OBJECTS_LIMIT) {
      const end = Math.min(start + LEGACY_DELETE_OBJECTS_LIMIT, prefixes.length);
      const objects = yield* gateway.deleteObjects(bucket, prefixes.slice(start, end));
      removed.push(...objects);
    }
    for (const o of removed) summary.deleted.push(o.name);
    return removed;
  });

/**
 * Go `RemoveStoragePathAll` (`rm.go:102-143`): BFS over the prefix tree (LIFO),
 * deleting files per directory, then deleting the bucket itself when the prefix
 * is empty. `prefix` is terminated by `/` or empty.
 */
const removeStoragePathAll = (
  gateway: LegacyStorageGateway,
  output: typeof Output.Service,
  bucket: string,
  prefix: string,
  summary: RmSummary,
) =>
  Effect.gen(function* () {
    const queue: Array<string> = [prefix];
    while (queue.length > 0) {
      const dirPrefix = queue.pop();
      if (dirPrefix === undefined) break;
      const paths = yield* legacyListStoragePaths(gateway, output, `/${bucket}/${dirPrefix}`);
      if (paths.length === 0 && prefix.length > 0) {
        return yield* new LegacyStorageObjectNotFoundError(`${bucket}/${prefix}`);
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
      }
    }
    if (prefix.length === 0) {
      yield* output.raw(`Deleting bucket: ${bucket}\n`, "stderr");
      yield* gateway.deleteBucket(bucket).pipe(
        Effect.flatMap((message) =>
          Effect.gen(function* () {
            yield* output.raw(`${message}\n`, "stderr");
            summary.buckets_deleted.push(bucket);
          }),
        ),
        Effect.catch((error) =>
          error instanceof LegacyStorageGatewayStatusError &&
          error.body.includes('"error":"Bucket not found"')
            ? output.raw(`Bucket not found: ${bucket}\n`, "stderr")
            : Effect.fail(error),
        ),
      );
    }
  });
