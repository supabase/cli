import { type Path } from "effect";

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
 * `objectsPath` and `filePath` are OS paths read through the platform `path`
 * service; the relative segment is normalized to forward slashes for the remote
 * key, so `posixPath` must be a POSIX `Path` service.
 */
export function bucketObjectKey(
  path: Path.Path,
  posixPath: Path.Path,
  bucketName: string,
  objectsPath: string,
  filePath: string,
): string {
  const relPath = path.relative(objectsPath, filePath);
  if (relPath === "") {
    return posixPath.join(bucketName, path.basename(filePath));
  }
  const relPosix = relPath.split(path.sep).join(posixPath.sep);
  return posixPath.join(bucketName, relPosix);
}
