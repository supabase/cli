import { Effect, FileSystem, Option, Path } from "effect";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { resolveYesWithProjectEnv } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { bold } from "../../../command-internal/colors.ts";
import { loadProjectEnv } from "../../../command-internal/db-config.toml-read.ts";
import { promptYesNo } from "../../../command-internal/prompt-yes-no.ts";
import {
  DELETE_OBJECTS_LIMIT,
  type StorageGateway,
} from "../../../command-internal/storage-gateway.ts";
import { StorageGatewayStatusError } from "../../../command-internal/storage-gateway.errors.ts";
import { splitBucketPrefix, storageIsDir } from "../../../command-internal/storage-url.ts";
import {
  assertStorageWorkdir,
  connectStorageGateway,
  loadStorageConfig,
  parseStorageUrlEffect,
} from "../storage.frame.ts";
import {
  StorageMissingBucketError,
  StorageMissingFlagError,
  StorageMutuallyExclusiveFlagsError,
  StorageObjectNotFoundError,
} from "../storage.errors.ts";
import { listStoragePaths } from "../storage.iterate.ts";

export interface StorageRmFlags {
  readonly files: ReadonlyArray<string>;
  readonly recursive: boolean;
  // `linked` is carried for parity with the ls/cp/mv handler signatures; routing
  // reads only `local` (Go `storage.go:21-32` reads `GetBool("local")`).
  readonly linked: boolean;
  readonly local: boolean;
  // TS-only override of the linked project ref — see push.command.ts (db push).
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
  const resolver = yield* ProjectRefResolver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  let linkedRef = "";

  yield* Effect.gen(function* () {
    yield* assertStorageWorkdir(cliSettings.workdir);

    // Resolve the project ref BEFORE reading the project `.env`: the
    // linked-project ref must be resolved strictly before the config load
    // (the `.env` work). An unlinked workdir must fail fast with the
    // not-linked guidance before a malformed/unreadable `supabase/.env` gets
    // a chance to mask it with an env-parse error.
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

    const projectRef = flags.local ? "" : yield* resolver.loadProjectRef(flags.projectRef);
    linkedRef = projectRef;
    // `--yes` OR `SUPABASE_YES`. Both the `--local` and (default) `--linked`
    // branches load the project `.env` files before the confirmation
    // prompt, so a `SUPABASE_YES` set only in `supabase/.env` must
    // auto-confirm here too.
    const projectEnv = yield* loadProjectEnv(fs, path, cliSettings.workdir);
    const yes = yield* resolveYesWithProjectEnv(projectEnv);
    const loaded = yield* loadStorageConfig(cliSettings, projectRef);
    if (loaded.appliedRemote !== undefined) {
      yield* output.raw(`Loading config override: [remotes.${loaded.appliedRemote}]\n`, "stderr");
    }

    // Group paths by bucket, validating BEFORE building the client (Go `rm.go:31-47`).
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

    const summary: RmSummary = { deleted: [], buckets_deleted: [] };

    yield* connectStorageGateway(
      { projectRef, config: loaded.config, userAgent: cliSettings.userAgent },
      (gateway) =>
        Effect.gen(function* () {
          // No paths: `-r` deletes every bucket, otherwise it's a missing-flag
          // error (Go `rm.go:52-63`, after the client is built).
          if (groups.size === 0) {
            if (!flags.recursive) {
              return yield* new StorageMissingFlagError();
            }
            const buckets = yield* gateway.listBuckets();
            for (const b of buckets) groups.set(b.name, [""]);
          }

          for (const [bucket, prefixes] of groups) {
            const shouldDelete = yield* promptYesNo(
              output,
              yes,
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
 * Go `RemoveStoragePathAll` (`rm.go:102-143`): BFS over the prefix tree (LIFO),
 * deleting files per directory, then deleting the bucket itself when the prefix
 * is empty. `prefix` is terminated by `/` or empty.
 */
const removeStoragePathAll = (
  gateway: StorageGateway,
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
          error instanceof StorageGatewayStatusError &&
          error.body.includes('"error":"Bucket not found"')
            ? output.raw(`Bucket not found: ${bucket}\n`, "stderr")
            : Effect.fail(error),
        ),
      );
    }
  });
