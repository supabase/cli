import * as nodePath from "node:path";

import { Effect, FileSystem, Option } from "effect";

import { detectContentType } from "./detect-content-type.ts";

/**
 * Resolves the content-type for a file upload, shared by `seed buckets` and
 * `storage cp`: sniff the first ≤512 bytes, then refine a generic `text/plain`
 * result by file extension. Bytes win over extension, so a PNG named `.txt`
 * still uploads as `image/png`.
 */

const SNIFF_LEN = 512;

/**
 * Reads the first ≤512 bytes of a file for content-type sniffing without
 * buffering the whole file. Returns an empty buffer on EOF or any read error;
 * an unreadable file fails later at the streaming upload open, so the sniff
 * failure is harmless.
 */
export const readSniffBytes = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  absPath: string,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(absPath, { flag: "r" });
      return yield* handle.readAlloc(SNIFF_LEN);
    }),
  ).pipe(
    Effect.map(Option.getOrElse(() => new Uint8Array(0))),
    Effect.catch(() => Effect.succeed(new Uint8Array(0))),
  );
});

/**
 * Refines a content-type by file extension, but only when it is a generic
 * `text/plain`. Applied to both the sniffed type and an explicit
 * `--content-type` value.
 */
export function refineUploadContentType(contentType: string, filePath: string): string {
  if (contentType.includes("text/plain")) {
    const ext = nodePath.extname(filePath).toLowerCase();
    const refined = MIME_BY_EXTENSION[ext];
    if (refined !== undefined && refined !== "") return refined;
  }
  return contentType;
}

/** Resolves the upload content-type from sniffed bytes, refining a generic `text/plain` by extension. */
export function contentTypeForUpload(sniff: Uint8Array, filePath: string): string {
  return refineUploadContentType(detectContentType(sniff), filePath);
}

// Built-in extension-to-MIME table used only to refine a generic `text/plain`
// sniff result. Does not consult the OS MIME database, which is host-dependent.
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
