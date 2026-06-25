import * as nodePath from "node:path";

/**
 * Pure path helper for `seed buckets` object upload, ported from Go's
 * `UpsertObjects` (`apps/cli-go/pkg/storage/batch.go`). Content-type resolution
 * and the sniff read live in `legacy/shared/legacy-storage-content-type.ts`
 * (shared with `storage cp`); size parsing in
 * `legacy/shared/legacy-storage-bucket-config.ts`.
 */

/**
 * Destination object key for a local file, ported from `UpsertObjects`
 * (`batch.go:101-118`). Mirrors Go's `filepath.Rel(localPath, filePath)` +
 * `path.Join(name, …)`:
 *   - single-file `objects_path` (the file is the path itself, Go's `relPath == "."`)
 *     → `<bucket>/<basename>`
 *   - otherwise → `<bucket>/<relative-posix-path>`
 *
 * `objectsPath` and `filePath` are OS paths; the relative segment is normalised
 * to forward slashes (`filepath.ToSlash`) for the remote key.
 */
export function legacyBucketObjectKey(
  bucketName: string,
  objectsPath: string,
  filePath: string,
): string {
  const relPath = nodePath.relative(objectsPath, filePath);
  if (relPath === "") {
    return nodePath.posix.join(bucketName, nodePath.basename(filePath));
  }
  const relPosix = relPath.split(nodePath.sep).join(nodePath.posix.sep);
  return nodePath.posix.join(bucketName, relPosix);
}
