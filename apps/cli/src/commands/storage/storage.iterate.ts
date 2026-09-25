import { Effect, Option, Stream } from "effect";

import { Output } from "../../shared/output/output.service.ts";
import type { StorageGatewayError } from "../../command-internal/storage-gateway.errors.ts";
import { PAGE_LIMIT, type StorageGateway } from "../../command-internal/storage-gateway.ts";
import { goPathSplit, splitBucketPrefix } from "../../command-internal/storage-url.ts";

/**
 * Pagination + traversal helpers shared by `storage ls/cp/mv/rm`. `callback` receives
 * each entry name (or full path for the recursive variant); a directory entry has a
 * trailing `/`. The `Loading page:` notice is text-mode only.
 */

const storagePaths = (
  gateway: StorageGateway,
  output: typeof Output.Service,
  remotePath: string,
): Stream.Stream<string, StorageGatewayError> => {
  const [bucket, prefix] = splitBucketPrefix(remotePath);
  if (bucket.length === 0 || (prefix.length === 0 && !remotePath.endsWith("/"))) {
    return Stream.unwrap(
      gateway
        .listBuckets()
        .pipe(
          Effect.map((buckets) =>
            Stream.fromArray(
              buckets.filter((b) => b.name.startsWith(bucket)).map((b) => `${b.name}/`),
            ),
          ),
        ),
    );
  }
  return Stream.paginate(0, (page) =>
    (page > 0 && output.format === "text"
      ? output.raw(`Loading page: ${page}\n`, "stderr")
      : Effect.void
    ).pipe(
      Effect.andThen(gateway.listObjects(bucket, prefix, page)),
      Effect.map((objects): readonly [ReadonlyArray<string>, Option.Option<number>] => [
        objects.map((object) => (object.isDir ? `${object.name}/` : object.name)),
        objects.length === PAGE_LIMIT ? Option.some(page + 1) : Option.none(),
      ]),
    ),
  );
};

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
  storagePaths(gateway, output, remotePath).pipe(Stream.runForEach(callback));

/** Collects every entry name under `remotePath` into an array. */
export const listStoragePaths = (
  gateway: StorageGateway,
  output: typeof Output.Service,
  remotePath: string,
): Effect.Effect<ReadonlyArray<string>, StorageGatewayError> =>
  Stream.runCollect(storagePaths(gateway, output, remotePath));

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
