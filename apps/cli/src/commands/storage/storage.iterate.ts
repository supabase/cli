import { Effect } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import type { StorageGatewayError } from "../../command-internal/storage-gateway.errors.ts";
import { PAGE_LIMIT, type StorageGateway } from "../../command-internal/storage-gateway.ts";
import { goPathSplit, splitBucketPrefix } from "../../command-internal/storage-url.ts";

/**
 * Pagination + BFS traversal shared by `storage ls/cp/mv/rm`. The `callback`
 * receives each entry name (or full path, for the recursive variant); a
 * directory entry has a trailing `/`. Errors from the gateway or the
 * callback short-circuit the loop, returning the first error.
 *
 * The `Loading page:` notice is emitted only in text mode — json/stream-json
 * consumers don't want the pagination noise on stderr.
 */

/**
 * Go `ls.IterateStoragePaths` (`ls.go:44-82`): when the path resolves to the
 * bucket root, list buckets filtered by the (possibly empty) bucket prefix;
 * otherwise page through objects under the prefix.
 */
export const iterateStoragePaths = <E>(
  gateway: StorageGateway,
  output: typeof Output.Service,
  remotePath: string,
  callback: (objectName: string) => Effect.Effect<void, E>,
): Effect.Effect<void, StorageGatewayError | E> =>
  Effect.gen(function* () {
    const [bucket, prefix] = splitBucketPrefix(remotePath);
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
      if (objects.length === PAGE_LIMIT) {
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
export const listStoragePaths = (
  gateway: StorageGateway,
  output: typeof Output.Service,
  remotePath: string,
): Effect.Effect<ReadonlyArray<string>, StorageGatewayError> =>
  Effect.gen(function* () {
    const result: Array<string> = [];
    yield* iterateStoragePaths(gateway, output, remotePath, (objectName) =>
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
export const iterateStoragePathsAll = <E>(
  gateway: StorageGateway,
  output: typeof Output.Service,
  remotePath: string,
  callback: (objectPath: string) => Effect.Effect<void, E>,
): Effect.Effect<void, StorageGatewayError | E> =>
  Effect.gen(function* () {
    const basePath = remotePath.endsWith("/") ? remotePath : goPathSplit(remotePath)[0];
    const dirQueue: Array<string> = [];

    yield* iterateStoragePaths(gateway, output, remotePath, (objectName) =>
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
      yield* iterateStoragePaths(gateway, output, dirPath, (objectName) =>
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
      const [bucket, prefix] = splitBucketPrefix(dirPath);
      if (empty && prefix.length === 0) {
        yield* callback(`${bucket}/`);
      }
    }
  });
