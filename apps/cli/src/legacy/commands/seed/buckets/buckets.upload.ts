import * as nodePath from "node:path";

import { legacyDetectContentType } from "../../../shared/legacy-detect-content-type.ts";
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
 * Content-type for an uploaded object, mirroring Go's `UploadObject`
 * (`apps/cli-go/pkg/storage/objects.go:77-108`): run `http.DetectContentType`
 * on the first 512 bytes (the **bytes** decide), and only when that returns a
 * generic `text/plain` refine it via `mime.TypeByExtension` on the file
 * extension. So a PNG/PDF named `.txt` is stored as `image/png`/`application/pdf`
 * (bytes win), while a plain-text file is refined to e.g. `application/json` by
 * its extension.
 *
 * `sniff` is the first ≤512 bytes of the file (Go's `io.LimitReader(f, 512)`).
 *
 * The extension table is Go's built-in `mime` table (`mime/type.go`
 * `builtinTypesLower`). NOTE: Go's `mime.TypeByExtension` additionally augments
 * this from the OS MIME database (`/etc/mime.types`, the Windows registry, …),
 * which is host-dependent and not reproduced here — the deterministic built-in
 * table is the faithful baseline and covers the standard extensions; the
 * byte-sniff step above (the dominant, non-text path) is reproduced exactly.
 */
export function legacyContentTypeForUpload(sniff: Uint8Array, filePath: string): string {
  const detected = legacyDetectContentType(sniff);
  if (detected.includes("text/plain")) {
    const ext = nodePath.extname(filePath).toLowerCase();
    const refined = MIME_BY_EXTENSION[ext];
    if (refined !== undefined && refined !== "") return refined;
  }
  return detected;
}

// Go's built-in `mime` extension table (`mime/type.go` `builtinTypesLower`),
// used only to refine a generic `text/plain` sniff result. Keys are lowercase;
// `legacyContentTypeForUpload` lowercases the extension before lookup, matching
// `mime.TypeByExtension`'s case-insensitive fallback.
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".ai": "application/postscript",
  ".apk": "application/vnd.android.package-archive",
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".bin": "application/octet-stream",
  ".bmp": "image/bmp",
  ".com": "application/octet-stream",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ehtml": "text/html; charset=utf-8",
  ".eml": "message/rfc822",
  ".eps": "application/postscript",
  ".exe": "application/octet-stream",
  ".flac": "audio/flac",
  ".gif": "image/gif",
  ".gz": "application/gzip",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/vnd.microsoft.icon",
  ".ics": "text/calendar; charset=utf-8",
  ".jfif": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".ogv": "video/ogg",
  ".opus": "audio/ogg",
  ".pdf": "application/pdf",
  ".pjp": "image/jpeg",
  ".pjpeg": "image/jpeg",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ps": "application/postscript",
  ".rdf": "application/rdf+xml",
  ".rtf": "application/rtf",
  ".shtml": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".text": "text/plain; charset=utf-8",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".txt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".webp": "image/webp",
  ".xbl": "text/xml; charset=utf-8",
  ".xbm": "image/x-xbitmap",
  ".xht": "application/xhtml+xml",
  ".xhtml": "application/xhtml+xml",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "text/xml; charset=utf-8",
  ".xsl": "text/xml; charset=utf-8",
  ".zip": "application/zip",
};
