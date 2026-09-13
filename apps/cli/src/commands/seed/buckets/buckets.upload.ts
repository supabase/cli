import * as nodePath from "node:path";

/**
 * Pure path helper for `seed buckets` object upload. Content-type resolution
 * and the sniff read live in `command-internal/storage-content-type.ts`
 * (shared with `storage cp`); size parsing lives in
 * `command-internal/storage-bucket-config.ts`.
 */

/**
 * Destination object key for a local file relative to `objectsPath`:
 *   - single-file `objects_path` (the file is the path itself) → `<bucket>/<basename>`
 *   - otherwise → `<bucket>/<relative-posix-path>`
 *
 * `objectsPath` and `filePath` are OS paths; the relative segment is normalized
 * to forward slashes for the remote key.
 */
export function bucketObjectKey(bucketName: string, objectsPath: string, filePath: string): string {
  const relPath = nodePath.relative(objectsPath, filePath);
  if (relPath === "") {
    return nodePath.posix.join(bucketName, nodePath.basename(filePath));
  }
  const relPosix = relPath.split(nodePath.sep).join(nodePath.posix.sep);
  return nodePath.posix.join(bucketName, relPosix);
}
