import { type Path } from "effect";

/**
 * Pure path helper for `seed buckets` object upload. Content-type resolution
 * and the sniff read live in `command-internal/storage-content-type.ts`
 * (shared with `storage cp`); size parsing lives in
 * `command-internal/storage-bucket-config.ts`.
 */

/**
 * Object key inside its bucket for a local file relative to `objectsPath`:
 *   - single-file `objects_path` (the file is the path itself) → `<basename>`
 *   - otherwise → `<relative-posix-path>`
 *
 * `objectsPath` and `filePath` are OS paths read through the platform `path`
 * service; the relative segment is normalized to forward slashes for the remote
 * key through `posixPath`, which must be a POSIX `Path` service.
 */
export function bucketObjectKey(
  { path, posixPath }: { readonly path: Path.Path; readonly posixPath: Path.Path },
  objectsPath: string,
  filePath: string,
): string {
  const relPath = path.relative(objectsPath, filePath);
  if (relPath === "") {
    return path.basename(filePath);
  }
  return relPath.split(path.sep).join(posixPath.sep);
}
