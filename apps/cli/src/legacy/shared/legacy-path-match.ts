/**
 * Faithful, BYTE-level port of Go's stdlib `path.Match` (`$GOROOT/src/path/match.go`),
 * used by the seed-file globber to expand `[db.seed] sql_paths` exactly like the Go
 * CLI's `config.Glob.Files` → `io/fs.Glob` → `path.Match` chain.
 *
 * Why byte-level, not code-point-level: Go strings are raw byte slices — every index,
 * slice, and length in `path.Match` operates on UTF-8 BYTES, not decoded characters.
 * This matters most in the `*`-retry loop (`legacyPathMatch`'s inner `for` below):
 * Go retries the starred chunk at every BYTE offset of `name`, including offsets that
 * land in the middle of a multibyte UTF-8 character. When that happens, Go's
 * `unicode/utf8.DecodeRuneInString` decodes the LEADING (invalid, mid-character)
 * continuation byte as a single-byte `U+FFFD` "rune" — it never throws and never
 * consumes more than one byte for invalid input — so a `?` operator in the retried
 * chunk can advance past exactly one such byte and let the retry succeed where a
 * code-point-stepping port would not. Verified empirically against `apps/cli-go`
 * (a `path.Match` scratch probe): `Match("*??.sql", "！.sql")` — a single fullwidth
 * exclamation mark, U+FF01, 3 UTF-8 bytes — returns `true`: the second `?` in the
 * retried chunk lands on the fullwidth character's 2nd and 3rd bytes (both mid-character
 * continuation bytes, each decoded as one `U+FFFD` "rune"), not on a real code point. A
 * prior code-point-based port of this file returned `false` for that same case.
 *
 * Why a hand port instead of a JS `RegExp`: Go's glob grammar and JS regex character
 * classes diverge — POSIX classes (`[[:alpha:]]`), `\d`/`\w`, and a leading `^` mean
 * different things, and Go reports a malformed class as an error (`path.ErrBadPattern`)
 * where JS would silently reinterpret it. Compiling each segment to a `RegExp` leaked
 * those JS-only semantics; porting the algorithm keeps seed globbing byte-compatible
 * with Go, including the malformed-pattern handling and the byte-offset retry above.
 */

/** Mirrors Go's `path.Match` return `(matched bool, err error)`; `badPattern` ↔ `path.ErrBadPattern`. */
export interface LegacyPathMatchResult {
  readonly matched: boolean;
  readonly badPattern: boolean;
}

/** Go's `path.ErrBadPattern.Error()` text, surfaced verbatim in seed glob warnings. */
export const LEGACY_BAD_PATTERN_MESSAGE = "syntax error in pattern";

const BAD_PATTERN: LegacyPathMatchResult = { matched: false, badPattern: true };

const UTF8_ENCODER = new TextEncoder();

/**
 * `TextEncoder.encode` returns `Uint8Array<ArrayBuffer>` (never a
 * `SharedArrayBuffer`-backed view) — naming that explicitly so every `.subarray()`
 * slice threaded through this module's helpers keeps that narrower type instead of
 * widening to the generic `Uint8Array<ArrayBufferLike>` default.
 */
type Bytes = Uint8Array<ArrayBuffer>;

const RUNE_ERROR = 0xfffd;
const SLASH = 0x2f;
const STAR = 0x2a;
const QUESTION = 0x3f;
const LBRACKET = 0x5b;
const RBRACKET = 0x5d;
const CARET = 0x5e;
const HYPHEN = 0x2d;
const BACKSLASH = 0x5c;

interface DecodedRune {
  readonly r: number;
  readonly size: number;
}

/**
 * Port of Go's `unicode/utf8.DecodeRuneInString`, decoding the rune starting at byte
 * offset `i` of `b`. Any invalid or truncated sequence decodes as `(RuneError, 1)` —
 * never throws, never consumes more than the single invalid lead byte — matching Go's
 * documented behaviour exactly (`$GOROOT/src/unicode/utf8/utf8.go`'s `first` table and
 * `acceptRanges`, transcribed here as explicit range checks per lead byte rather than
 * the table itself, for readability; verified to agree with the table for every lead
 * byte class, including the overlong/surrogate/out-of-range exclusions on `0xE0`,
 * `0xED`, `0xF0`, and `0xF4`).
 */
const decodeRune = (b: Bytes, i: number): DecodedRune => {
  const n = b.length - i;
  if (n <= 0) return { r: RUNE_ERROR, size: 0 };
  const b0 = b[i]!;
  if (b0 < 0x80) return { r: b0, size: 1 };
  let size: number;
  let lo: number;
  let hi: number;
  if (b0 >= 0xc2 && b0 <= 0xdf) {
    size = 2;
    lo = 0x80;
    hi = 0xbf;
  } else if (b0 === 0xe0) {
    size = 3; // Excludes the overlong 3-byte encoding.
    lo = 0xa0;
    hi = 0xbf;
  } else if ((b0 >= 0xe1 && b0 <= 0xec) || b0 === 0xee || b0 === 0xef) {
    size = 3;
    lo = 0x80;
    hi = 0xbf;
  } else if (b0 === 0xed) {
    size = 3; // Excludes the UTF-16 surrogate range U+D800-U+DFFF.
    lo = 0x80;
    hi = 0x9f;
  } else if (b0 === 0xf0) {
    size = 4; // Excludes the overlong 4-byte encoding.
    lo = 0x90;
    hi = 0xbf;
  } else if (b0 >= 0xf1 && b0 <= 0xf3) {
    size = 4;
    lo = 0x80;
    hi = 0xbf;
  } else if (b0 === 0xf4) {
    size = 4; // Caps the range at U+10FFFF.
    lo = 0x80;
    hi = 0x8f;
  } else {
    // 0x80-0xC1: a bare continuation byte or an overlong 2-byte lead. 0xF5-0xFF: past
    // the max valid lead byte. Both are invalid lead bytes.
    return { r: RUNE_ERROR, size: 1 };
  }
  if (n < size) return { r: RUNE_ERROR, size: 1 };
  const b1 = b[i + 1]!;
  if (b1 < lo || b1 > hi) return { r: RUNE_ERROR, size: 1 };
  if (size === 2) return { r: ((b0 & 0x1f) << 6) | (b1 & 0x3f), size: 2 };
  const b2 = b[i + 2]!;
  if (b2 < 0x80 || b2 > 0xbf) return { r: RUNE_ERROR, size: 1 };
  if (size === 3) return { r: ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f), size: 3 };
  const b3 = b[i + 3]!;
  if (b3 < 0x80 || b3 > 0xbf) return { r: RUNE_ERROR, size: 1 };
  return {
    r: ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f),
    size: 4,
  };
};

interface ScanChunk {
  readonly star: boolean;
  readonly chunk: Bytes;
  readonly rest: Bytes;
}

/** Go's `scanChunk`: the next non-`*` segment, possibly preceded by a `*`. */
const scanChunk = (pattern: Bytes): ScanChunk => {
  let star = false;
  let p = pattern;
  while (p.length > 0 && p[0] === STAR) {
    p = p.subarray(1);
    star = true;
  }
  let inrange = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === BACKSLASH) {
      if (i + 1 < p.length) i++;
    } else if (c === LBRACKET) {
      inrange = true;
    } else if (c === RBRACKET) {
      inrange = false;
    } else if (c === STAR && !inrange) {
      return { star, chunk: p.subarray(0, i), rest: p.subarray(i) };
    }
  }
  return { star, chunk: p, rest: p.subarray(p.length) };
};

interface GetEsc {
  readonly r: number;
  readonly rest: Bytes;
  readonly bad: boolean;
}

/** Go's `getEsc`: a possibly-escaped character from inside a class. */
const getEsc = (chunk: Bytes): GetEsc => {
  if (chunk.length === 0 || chunk[0] === HYPHEN || chunk[0] === RBRACKET) {
    return { r: 0, rest: chunk, bad: true };
  }
  let c = chunk;
  if (c[0] === BACKSLASH) {
    c = c.subarray(1);
    if (c.length === 0) return { r: 0, rest: c, bad: true };
  }
  const { r, size } = decodeRune(c, 0);
  // Go: `if r == utf8.RuneError && n == 1 { err = ErrBadPattern }` — a genuinely
  // invalid byte, not a literal (valid, 3-byte-encoded) U+FFFD character.
  if (r === RUNE_ERROR && size === 1) return { r, rest: c.subarray(1), bad: true };
  const rest = c.subarray(size);
  return { r, rest, bad: rest.length === 0 };
};

interface MatchChunk {
  readonly rest: Bytes;
  readonly ok: boolean;
  readonly bad: boolean;
}

const EMPTY_BYTES = new Uint8Array(0);
const BAD_CHUNK: MatchChunk = { rest: EMPTY_BYTES, ok: false, bad: true };

/**
 * Go's `matchChunk`: match the all-single-char-operators `chunk` against the
 * start of `s`. Once the match fails the loop keeps walking `chunk` (no longer
 * reading `s`) so a malformed pattern is still reported.
 */
const matchChunk = (chunkIn: Bytes, sIn: Bytes): MatchChunk => {
  let chunk = chunkIn;
  let s = sIn;
  let failed = false;
  while (chunk.length > 0) {
    if (!failed && s.length === 0) failed = true;
    const op = chunk[0]!;
    if (op === LBRACKET) {
      let r = 0;
      if (!failed) {
        const decoded = decodeRune(s, 0);
        r = decoded.r;
        s = s.subarray(decoded.size);
      }
      chunk = chunk.subarray(1);
      let negated = false;
      if (chunk.length > 0 && chunk[0] === CARET) {
        negated = true;
        chunk = chunk.subarray(1);
      }
      let match = false;
      let nrange = 0;
      for (;;) {
        if (chunk.length > 0 && chunk[0] === RBRACKET && nrange > 0) {
          chunk = chunk.subarray(1);
          break;
        }
        const lo = getEsc(chunk);
        if (lo.bad) return BAD_CHUNK;
        chunk = lo.rest;
        let hi = lo.r;
        if (chunk.length > 0 && chunk[0] === HYPHEN) {
          const hiEsc = getEsc(chunk.subarray(1));
          if (hiEsc.bad) return BAD_CHUNK;
          chunk = hiEsc.rest;
          hi = hiEsc.r;
        }
        if (lo.r <= r && r <= hi) match = true;
        nrange++;
      }
      if (match === negated) failed = true;
    } else if (op === QUESTION) {
      if (!failed) {
        if (s[0] === SLASH) failed = true;
        const { size } = decodeRune(s, 0);
        s = s.subarray(size);
      }
      chunk = chunk.subarray(1);
    } else if (op === BACKSLASH) {
      chunk = chunk.subarray(1);
      if (chunk.length === 0) return BAD_CHUNK;
      if (!failed) {
        if (chunk[0] !== s[0]) failed = true;
        s = s.subarray(1);
      }
      chunk = chunk.subarray(1);
    } else {
      if (!failed) {
        if (chunk[0] !== s[0]) failed = true;
        s = s.subarray(1);
      }
      chunk = chunk.subarray(1);
    }
  }
  return failed ? { rest: EMPTY_BYTES, ok: false, bad: false } : { rest: s, ok: true, bad: false };
};

/**
 * Reports whether `name` matches the shell pattern `pattern`, using Go's
 * `path.Match` semantics. `badPattern` is set (instead of throwing) when the
 * pattern is malformed, mirroring Go's `path.ErrBadPattern`.
 */
export const legacyPathMatch = (pattern: string, name: string): LegacyPathMatchResult => {
  let pat = UTF8_ENCODER.encode(pattern);
  let nm = UTF8_ENCODER.encode(name);
  while (pat.length > 0) {
    const scan = scanChunk(pat);
    pat = scan.rest;
    if (scan.star && scan.chunk.length === 0) {
      // Trailing `*` matches the rest of the name unless it contains a `/`. `/` is
      // never a UTF-8 continuation byte, so a raw byte scan is safe here regardless
      // of any multibyte characters elsewhere in `nm`.
      return { matched: !nm.includes(SLASH), badPattern: false };
    }
    const m = matchChunk(scan.chunk, nm);
    if (m.bad) return BAD_PATTERN;
    // If this is the last chunk, the name must be fully consumed; otherwise a
    // later `*` could still match, so only accept a partial match mid-pattern.
    if (m.ok && (m.rest.length === 0 || pat.length > 0)) {
      nm = m.rest;
      continue;
    }
    if (scan.star) {
      // Look for a match skipping one BYTE at a time (see this file's top comment
      // for why byte-, not code-point-, stepping matters here); `*` cannot cross `/`.
      let advanced = false;
      for (let i = 0; i < nm.length && nm[i] !== SLASH; i++) {
        const skip = matchChunk(scan.chunk, nm.subarray(i + 1));
        if (skip.bad) return BAD_PATTERN;
        if (skip.ok) {
          if (pat.length === 0 && skip.rest.length > 0) continue;
          nm = skip.rest;
          advanced = true;
          break;
        }
      }
      if (advanced) continue;
    }
    // No match: still verify the rest of the pattern is well-formed (Go does).
    while (pat.length > 0) {
      const tail = scanChunk(pat);
      pat = tail.rest;
      if (matchChunk(tail.chunk, EMPTY_BYTES).bad) return BAD_PATTERN;
    }
    return { matched: false, badPattern: false };
  }
  return { matched: nm.length === 0, badPattern: false };
};
