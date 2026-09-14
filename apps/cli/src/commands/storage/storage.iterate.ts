import { Effect } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import type { StorageGatewayError } from "../../command-internal/storage-gateway.errors.ts";
import { PAGE_LIMIT, type StorageGateway } from "../../command-internal/storage-gateway.ts";
import { goPathSplit, splitBucketPrefix } from "../../command-internal/storage-url.ts";

/**
 * Pagination + traversal helpers shared by `storage ls/cp/mv/rm`. `callback` receives
 * each entry name (or full path for the recursive variant); a directory entry has a
 * trailing `/`. The `Loading page:` notice is text-mode only.
 */

/**
 * Lists buckets filtered by prefix when `remotePath` resolves to the bucket root;
 * otherwise pages through objects under the prefix.
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

/** Collects every entry name under `remotePath` into an array. */
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
 * Walks the directory tree with a stack, invoking `callback` with each object's
 * full path. An empty bucket is reported as `<bucket>/`.
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
      const [bucket, prefix] = splitBucketPrefix(dirPath);
      if (empty && prefix.length === 0) {
        yield* callback(`${bucket}/`);
      }
    }
  });
