/**
 * Faithful 1:1 port of Go's `net/http` content sniffer (`net/http/sniff.go`'s
 * `DetectContentType` + `sniffSignatures`), reproduced from the Go 1.x stdlib.
 *
 * Go's `seed buckets` upload path runs `http.DetectContentType` on the first 512
 * bytes of each object (`apps/cli-go/pkg/storage/objects.go:78-83`), so the
 * stored Storage `Content-Type` metadata is byte-driven, not extension-driven.
 * Porting this verbatim is the only way to store the same Content-Type the Go CLI
 * would. The signature table and its ORDER are 1:1 with Go's `sniffSignatures`
 * (first match wins); kept dependency-free and pure for a Go-parity test corpus.
 */

// The algorithm uses at most sniffLen bytes to make its decision.
const SNIFF_LEN = 512;

/** Latin-1 byte view of a string literal (each char code is one byte). */
function bytesOf(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i) & 0xff;
  }
  return out;
}

// isWS reports whether the byte is a whitespace byte (0xWS) per the spec.
function isWS(b: number): boolean {
  return b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20;
}

// isTT reports whether the byte is a tag-terminating byte (0xTT) per the spec.
function isTT(b: number): boolean {
  return b === 0x20 || b === 0x3e; // ' ' or '>'
}

type SniffSig = (data: Uint8Array, firstNonWS: number) => string | undefined;

// `noUncheckedIndexedAccess` types `Uint8Array[i]` as `number | undefined`; this
// reads a byte that the caller has already length-guarded, returning a sentinel
// (-1, never a valid byte) on the dead out-of-bounds path so the compiler is
// satisfied without `as`/`!`.
function byteAt(arr: Uint8Array, i: number): number {
  const b = arr[i];
  return b === undefined ? -1 : b;
}

// bytes.HasPrefix(data, sig).
function exactSig(sig: string, ct: string): SniffSig {
  const pat = bytesOf(sig);
  return (data) => {
    if (data.length < pat.length) return undefined;
    for (let i = 0; i < pat.length; i++) {
      if (byteAt(data, i) !== byteAt(pat, i)) return undefined;
    }
    return ct;
  };
}

// WHATWG masked pattern match (`maskedSig`).
function maskedSig(mask: string, pat: string, ct: string, skipWS = false): SniffSig {
  const m = bytesOf(mask);
  const p = bytesOf(pat);
  return (data, firstNonWS) => {
    const d = skipWS ? data.subarray(firstNonWS) : data;
    if (p.length !== m.length) return undefined;
    if (d.length < p.length) return undefined;
    for (let i = 0; i < p.length; i++) {
      if ((byteAt(d, i) & byteAt(m, i)) !== byteAt(p, i)) return undefined;
    }
    return ct;
  };
}

// `htmlSig`: case-insensitive tag prefix followed by a tag-terminating byte. The
// pattern is stored uppercase (as in Go); the data byte is uppercased via & 0xDF
// only where the pattern byte is A-Z.
function htmlSig(sig: string): SniffSig {
  const h = bytesOf(sig);
  return (data, firstNonWS) => {
    const d = data.subarray(firstNonWS);
    if (d.length < h.length + 1) return undefined;
    for (let i = 0; i < h.length; i++) {
      const b = byteAt(h, i);
      let db = byteAt(d, i);
      if (b >= 0x41 && b <= 0x5a) db &= 0xdf; // 'A'..'Z'
      if (b !== db) return undefined;
    }
    if (!isTT(byteAt(d, h.length))) return undefined;
    return "text/html; charset=utf-8";
  };
}

// `mp4Sig`: WHATWG MP4 box signature (section 6.2.1).
const mp4Sig: SniffSig = (data) => {
  if (data.length < 12) return undefined;
  const boxSize =
    ((byteAt(data, 0) << 24) |
      (byteAt(data, 1) << 16) |
      (byteAt(data, 2) << 8) |
      byteAt(data, 3)) >>>
    0;
  if (data.length < boxSize || boxSize % 4 !== 0) return undefined;
  // data[4:8] == "ftyp"
  if (
    byteAt(data, 4) !== 0x66 ||
    byteAt(data, 5) !== 0x74 ||
    byteAt(data, 6) !== 0x79 ||
    byteAt(data, 7) !== 0x70
  ) {
    return undefined;
  }
  for (let st = 8; st < boxSize; st += 4) {
    if (st === 12) continue; // major-brand version bytes
    if (st + 3 > data.length) break;
    if (
      byteAt(data, st) === 0x6d &&
      byteAt(data, st + 1) === 0x70 &&
      byteAt(data, st + 2) === 0x34
    ) {
      return "video/mp4"; // "mp4"
    }
  }
  return undefined;
};

// `textSig` (must be last): text/plain unless a binary control byte is present.
const textSig: SniffSig = (data, firstNonWS) => {
  for (let i = firstNonWS; i < data.length; i++) {
    const b = byteAt(data, i);
    if (b <= 0x08 || b === 0x0b || (b >= 0x0e && b <= 0x1a) || (b >= 0x1c && b <= 0x1f)) {
      return undefined;
    }
  }
  return "text/plain; charset=utf-8";
};

// 1:1 with Go's `sniffSignatures`, including order (first match wins).
const SNIFF_SIGNATURES: ReadonlyArray<SniffSig> = [
  htmlSig("<!DOCTYPE HTML"),
  htmlSig("<HTML"),
  htmlSig("<HEAD"),
  htmlSig("<SCRIPT"),
  htmlSig("<IFRAME"),
  htmlSig("<H1"),
  htmlSig("<DIV"),
  htmlSig("<FONT"),
  htmlSig("<TABLE"),
  htmlSig("<A"),
  htmlSig("<STYLE"),
  htmlSig("<TITLE"),
  htmlSig("<B"),
  htmlSig("<BODY"),
  htmlSig("<BR"),
  htmlSig("<P"),
  htmlSig("<!--"),
  maskedSig("\xFF\xFF\xFF\xFF\xFF", "<?xml", "text/xml; charset=utf-8", true),
  exactSig("%PDF-", "application/pdf"),
  exactSig("%!PS-Adobe-", "application/postscript"),
  // UTF BOMs.
  maskedSig("\xFF\xFF\x00\x00", "\xFE\xFF\x00\x00", "text/plain; charset=utf-16be"),
  maskedSig("\xFF\xFF\x00\x00", "\xFF\xFE\x00\x00", "text/plain; charset=utf-16le"),
  maskedSig("\xFF\xFF\xFF\x00", "\xEF\xBB\xBF\x00", "text/plain; charset=utf-8"),
  // Image types.
  exactSig("\x00\x00\x01\x00", "image/x-icon"),
  exactSig("\x00\x00\x02\x00", "image/x-icon"),
  exactSig("BM", "image/bmp"),
  exactSig("GIF87a", "image/gif"),
  exactSig("GIF89a", "image/gif"),
  maskedSig(
    "\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF\xFF\xFF",
    "RIFF\x00\x00\x00\x00WEBPVP",
    "image/webp",
  ),
  exactSig("\x89PNG\x0D\x0A\x1A\x0A", "image/png"),
  exactSig("\xFF\xD8\xFF", "image/jpeg"),
  // Audio and video types (ordering per the spec).
  maskedSig(
    "\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF",
    "FORM\x00\x00\x00\x00AIFF",
    "audio/aiff",
  ),
  maskedSig("\xFF\xFF\xFF", "ID3", "audio/mpeg"),
  maskedSig("\xFF\xFF\xFF\xFF\xFF", "OggS\x00", "application/ogg"),
  maskedSig("\xFF\xFF\xFF\xFF\xFF\xFF\xFF\xFF", "MThd\x00\x00\x00\x06", "audio/midi"),
  maskedSig(
    "\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF",
    "RIFF\x00\x00\x00\x00AVI ",
    "video/avi",
  ),
  maskedSig(
    "\xFF\xFF\xFF\xFF\x00\x00\x00\x00\xFF\xFF\xFF\xFF",
    "RIFF\x00\x00\x00\x00WAVE",
    "audio/wave",
  ),
  mp4Sig,
  exactSig("\x1A\x45\xDF\xA3", "video/webm"),
  // Font types.
  maskedSig(
    "\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\xFF\xFF",
    "\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00LP",
    "application/vnd.ms-fontobject",
  ),
  exactSig("\x00\x01\x00\x00", "font/ttf"),
  exactSig("OTTO", "font/otf"),
  exactSig("ttcf", "font/collection"),
  exactSig("wOFF", "font/woff"),
  exactSig("wOF2", "font/woff2"),
  // Archive types.
  exactSig("\x1F\x8B\x08", "application/x-gzip"),
  exactSig("PK\x03\x04", "application/zip"),
  exactSig("Rar!\x1A\x07\x00", "application/x-rar-compressed"),
  exactSig("Rar!\x1A\x07\x01\x00", "application/x-rar-compressed"),
  exactSig("\x00\x61\x73\x6D", "application/wasm"),
  textSig, // should be last
];

/**
 * Reproduces Go's `http.DetectContentType`: considers at most the first 512
 * bytes and always returns a valid MIME type, falling back to
 * `application/octet-stream` when no signature matches.
 */
export function legacyDetectContentType(input: Uint8Array): string {
  const data = input.length > SNIFF_LEN ? input.subarray(0, SNIFF_LEN) : input;
  let firstNonWS = 0;
  for (; firstNonWS < data.length; firstNonWS++) {
    if (!isWS(byteAt(data, firstNonWS))) break;
  }
  for (const sig of SNIFF_SIGNATURES) {
    const ct = sig(data, firstNonWS);
    if (ct !== undefined && ct !== "") return ct;
  }
  return "application/octet-stream";
}
