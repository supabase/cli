import * as nodePath from "node:path";

import { ramInBytes } from "../../../shared/legacy-size-units.ts";

/**
 * Pure path/encoding helpers for object upload, ported from
 * `apps/cli-go/pkg/storage/{objects,batch}.go`. Kept free of Effect / services
 * so the Go-parity rules (destination-key mapping, size parsing, content-type
 * fallback) stay unit-testable.
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

/**
 * Parse a `[storage.buckets.*].file_size_limit` config string (e.g. `"50MiB"`)
 * to the int64 byte count Go sends in the create/update bucket body
 * (`int64(bucket.FileSizeLimit)`, `batch.go:38/49`). `@supabase/config` keeps
 * the field as the raw human-readable string, so the conversion Go performs at
 * config-load time happens here instead. Throws on an unparseable value, which
 * the handler maps to a config-load error.
 */
export function legacyParseFileSizeLimit(sizeStr: string): number {
  return ramInBytes(sizeStr);
}

/**
 * Best-effort content-type by file extension. Go derives the type from
 * `http.DetectContentType` (first 512 bytes) with a `mime.TypeByExtension`
 * override for generic `text/plain` (`objects.go:66-109`); this extension-based
 * lookup is a parity approximation that is sufficient for the storage server,
 * which stores whatever is sent. Unknown extensions fall back to
 * `application/octet-stream`.
 */
export function legacyContentTypeForPath(filePath: string): string {
  const ext = nodePath.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/vnd.microsoft.icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wave",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".wasm": "application/wasm",
};
