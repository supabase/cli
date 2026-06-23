import { Effect } from "effect";

import { Output } from "../../../shared/output/output.service.ts";
import type { LegacyStorageGatewayError } from "../../shared/legacy-storage-gateway.errors.ts";
import {
  LEGACY_PAGE_LIMIT,
  type LegacyStorageGateway,
} from "../../shared/legacy-storage-gateway.ts";
import { legacyGoPathSplit, legacySplitBucketPrefix } from "../../shared/legacy-storage-url.ts";

/**
 * Pagination + BFS traversal shared by `storage ls/cp/mv/rm`, ported 1:1 from
 * `internal/storage/ls/ls.go`. The `callback` receives each entry name (or full
 * path, for the recursive variant); a directory entry has a trailing `/`. Errors
 * from the gateway or the callback short-circuit, exactly as Go's loop returns
 * the first error.
 *
 * The `Loading page:` notice (Go `fmt.Fprintln(os.Stderr, "Loading page:", N)`)
 * is emitted only in text mode — json/stream-json consumers don't want the
 * pagination noise on stderr.
 */

/**
 * Go `ls.IterateStoragePaths` (`ls.go:44-82`): when the path resolves to the
 * bucket root, list buckets filtered by the (possibly empty) bucket prefix;
 * otherwise page through objects under the prefix.
 */
export const legacyIterateStoragePaths = <E>(
  gateway: LegacyStorageGateway,
  output: typeof Output.Service,
  remotePath: string,
  callback: (objectName: string) => Effect.Effect<void, E>,
): Effect.Effect<void, LegacyStorageGatewayError | E> =>
  Effect.gen(function* () {
    const [bucket, prefix] = legacySplitBucketPrefix(remotePath);
    if (bucket.length === 0 || (prefix.length === 0 && !remotePath.endsWith("/"))) {
      const buckets = yield* gateway.listBuckets();
      for (const b of buckets) {
        if (b.name.startsWith(bucket)) {
          yield* callback(`${b.name}/`);
        }
      }
      return;
    }
    let pages = 1;
    for (let page = 0; page < pages; page++) {
      const objects = yield* gateway.listObjects(bucket, prefix, page);
      for (const object of objects) {
        yield* callback(object.isDir ? `${object.name}/` : object.name);
      }
      if (objects.length === LEGACY_PAGE_LIMIT) {
        if (output.format === "text") {
          yield* output.raw(`Loading page: ${pages}\n`, "stderr");
        }
        pages++;
      }
    }
  });

/**
 * Go `ls.ListStoragePaths` (`ls.go:35-42`): collect every entry name under the
 * path into an array.
 */
export const legacyListStoragePaths = (
  gateway: LegacyStorageGateway,
  output: typeof Output.Service,
  remotePath: string,
): Effect.Effect<ReadonlyArray<string>, LegacyStorageGatewayError> =>
  Effect.gen(function* () {
    const result: Array<string> = [];
    yield* legacyIterateStoragePaths(gateway, output, remotePath, (objectName) =>
      Effect.sync(() => {
        result.push(objectName);
      }),
    );
    return result;
  });

/**
 * Go `ls.IterateStoragePathsAll` (`ls.go:94-136`): BFS over the directory tree
 * (LIFO queue), invoking `callback` with each object's full path. An empty
 * bucket is reported as `<bucket>/`.
 */
export const legacyIterateStoragePathsAll = <E>(
  gateway: LegacyStorageGateway,
  output: typeof Output.Service,
  remotePath: string,
  callback: (objectPath: string) => Effect.Effect<void, E>,
): Effect.Effect<void, LegacyStorageGatewayError | E> =>
  Effect.gen(function* () {
    const basePath = remotePath.endsWith("/") ? remotePath : legacyGoPathSplit(remotePath)[0];
    const dirQueue: Array<string> = [];

    yield* legacyIterateStoragePaths(gateway, output, remotePath, (objectName) =>
      Effect.gen(function* () {
        const objectPath = basePath + objectName;
        if (objectName.endsWith("/")) {
          dirQueue.push(objectPath);
          return;
        }
        yield* callback(objectPath);
      }),
    );

    while (dirQueue.length > 0) {
      const dirPath = dirQueue.pop();
      if (dirPath === undefined) break;
      let empty = true;
      yield* legacyIterateStoragePaths(gateway, output, dirPath, (objectName) =>
        Effect.gen(function* () {
          empty = false;
          const objectPath = dirPath + objectName;
          if (objectName.endsWith("/")) {
            dirQueue.push(objectPath);
            return;
          }
          yield* callback(objectPath);
        }),
      );
      // Also report empty buckets (Go: a top-level empty bucket → `<bucket>/`).
      const [bucket, prefix] = legacySplitBucketPrefix(dirPath);
      if (empty && prefix.length === 0) {
        yield* callback(`${bucket}/`);
      }
    }
  });
