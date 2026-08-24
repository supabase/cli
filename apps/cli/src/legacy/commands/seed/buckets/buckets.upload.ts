import type { Path } from "effect";

/**
 * Pure path helper for `seed buckets` object upload, ported from
 * `UpsertObjects` (`apps/cli-go/pkg/storage/batch.go`). Content-type resolution
 * and the sniff read live in `legacy/shared/legacy-storage-content-type.ts`
 * (shared with `storage cp`); size parsing in
 * `legacy/shared/legacy-storage-bucket-config.ts`.
 */

/**
 * Destination object key for a local file, ported from `UpsertObjects`
 * (`batch.go:101-118`). Mirrors `filepath.Rel(localPath, filePath)` +
 * `path.Join(name, …)`:
 *   - single-file `objects_path` (the file is the path itself, `relPath == "."`)
 *     → `<bucket>/<basename>`
 *   - otherwise → `<bucket>/<relative-posix-path>`
 *
 * `objectsPath` and `filePath` are OS paths; the relative segment is normalised
 * to forward slashes (`filepath.ToSlash`) for the remote key.
 */
export function legacyBucketObjectKey(
  path: Path.Path,
  posixPath: Path.Path,
  bucketName: string,
  objectsPath: string,
  filePath: string,
): string {
  const relPath = path.relative(objectsPath, filePath);
  if (relPath === "") {
    return posixPath.join(bucketName, posixPath.basename(filePath));
  }
  const relPosix = relPath.split(path.sep).join(posixPath.sep);
  return posixPath.join(bucketName, relPosix);
}
