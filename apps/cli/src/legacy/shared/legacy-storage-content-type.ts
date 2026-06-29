import * as nodePath from "node:path";

import { Effect, FileSystem, Option } from "effect";

import { legacyDetectContentType } from "./legacy-detect-content-type.ts";

/**
 * Upload content-type resolution, ported from Go's `pkg/storage/objects.go`
 * (`ParseFileOptions` + `UploadObject`) and shared by `seed buckets` and
 * `storage cp`: run `http.DetectContentType` on the first ≤512 bytes (the bytes
 * decide), then refine a generic `text/plain` by file extension. So a PNG named
 * `.txt` stores as `image/png` (bytes win), while a JSON text file refines to
 * `application/json`.
 */

// Content-type sniff window: Go reads the first 512 bytes (`io.LimitReader(f, 512)`).
const LEGACY_SNIFF_LEN = 512;

/**
 * Read ONLY the first ≤512 bytes of a file for content-type sniffing, mirroring
 * Go's `io.LimitReader(f, 512)` (`pkg/storage/objects.go:78-79`) — the file is
 * NOT fully buffered. Returns an empty buffer on EOF or any read error (an
 * unreadable file then fails at the streaming upload open, so the sniff is moot).
 */
export const legacyReadSniffBytes = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  absPath: string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(absPath, { flag: "r" });
      return yield* handle.readAlloc(LEGACY_SNIFF_LEN);
    }),
  ).pipe(
    Effect.map(Option.getOrElse(() => new Uint8Array(0))),
    Effect.catch(() => Effect.succeed(new Uint8Array(0))),
  );
});

/**
 * Refine a content-type by file extension, but only when it is a generic
 * `text/plain` (Go's `if strings.Contains(fo.ContentType, "text/plain")` gate,
 * `objects.go:105-108`). Applied to both the sniffed type and an explicit
 * `--content-type` value, matching Go's `ParseFileOptions` → `UploadObject` flow.
 */
export function legacyRefineUploadContentType(contentType: string, filePath: string): string {
  if (contentType.includes("text/plain")) {
    const ext = nodePath.extname(filePath).toLowerCase();
    const refined = MIME_BY_EXTENSION[ext];
    if (refined !== undefined && refined !== "") return refined;
  }
  return contentType;
}

/**
 * Content-type for an uploaded object from its sniffed bytes: detect, then refine
 * a generic `text/plain` by extension. `sniff` is the first ≤512 bytes.
 */
export function legacyContentTypeForUpload(sniff: Uint8Array, filePath: string): string {
  return legacyRefineUploadContentType(legacyDetectContentType(sniff), filePath);
}

// Go's built-in `mime` extension table (`mime/type.go` `builtinTypesLower`), used
// only to refine a generic `text/plain` sniff result. NOTE: Go's
// `mime.TypeByExtension` also augments this from the OS MIME database
// (`/etc/mime.types`, the Windows registry), which is host-dependent and not
// reproduced here — the deterministic built-in table is the faithful baseline.
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
