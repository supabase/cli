/**
 * Faithful port of Go's stdlib `path.Match` (`$GOROOT/src/path/match.go`), used
 * by the seed-file globber to expand `[db.seed] sql_paths` exactly like the Go
 * CLI's `config.Glob.Files` → `io/fs.Glob` → `path.Match` chain.
 *
 * Why a hand port instead of a JS `RegExp`: Go's glob grammar and JS regex
 * character classes diverge — POSIX classes (`[[:alpha:]]`), `\d`/`\w`, and a
 * leading `^` mean different things, and Go reports a malformed class as an
 * error (`path.ErrBadPattern`) where JS would silently reinterpret it. Compiling
 * each segment to a `RegExp` leaked those JS-only semantics; porting the
 * algorithm keeps seed globbing byte-compatible with Go, including the
 * malformed-pattern handling.
 *
 * Pure — no Effect / service dependencies. Operates on code points; Go mixes
 * byte and rune indexing, which is equivalent for the BMP characters that occur
 * in real seed paths.
 */

/** Mirrors Go's `path.Match` return `(matched bool, err error)`; `badPattern` ↔ `path.ErrBadPattern`. */
export interface LegacyPathMatchResult {
  readonly matched: boolean;
  readonly badPattern: boolean;
}

/** Go's `path.ErrBadPattern.Error()` text, surfaced verbatim in seed glob warnings. */
export const LEGACY_BAD_PATTERN_MESSAGE = "syntax error in pattern";

const BAD_PATTERN: LegacyPathMatchResult = { matched: false, badPattern: true };

/** UTF-16 width (1 or 2 code units) of a code point. */
const runeWidth = (cp: number): number => (cp > 0xffff ? 2 : 1);

interface ScanChunk {
  readonly star: boolean;
  readonly chunk: string;
  readonly rest: string;
}

/** Go's `scanChunk`: the next non-`*` segment, possibly preceded by a `*`. */
const scanChunk = (pattern: string): ScanChunk => {
  let star = false;
  let p = pattern;
  while (p.length > 0 && p[0] === "*") {
    p = p.slice(1);
    star = true;
  }
  let inrange = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") {
      if (i + 1 < p.length) i++;
    } else if (c === "[") {
      inrange = true;
    } else if (c === "]") {
      inrange = false;
    } else if (c === "*" && !inrange) {
      return { star, chunk: p.slice(0, i), rest: p.slice(i) };
    }
  }
  return { star, chunk: p, rest: "" };
};

interface GetEsc {
  readonly r: number;
  readonly rest: string;
  readonly bad: boolean;
}

/** Go's `getEsc`: a possibly-escaped character from inside a class. */
const getEsc = (chunk: string): GetEsc => {
  if (chunk.length === 0 || chunk[0] === "-" || chunk[0] === "]") {
    return { r: 0, rest: chunk, bad: true };
  }
  let c = chunk;
  if (c[0] === "\\") {
    c = c.slice(1);
    if (c.length === 0) return { r: 0, rest: c, bad: true };
  }
  const r = c.codePointAt(0)!;
  const rest = c.slice(runeWidth(r));
  // Go errors when the class has no closing `]` after this character.
  return { r, rest, bad: rest.length === 0 };
};

interface MatchChunk {
  readonly rest: string;
  readonly ok: boolean;
  readonly bad: boolean;
}

const BAD_CHUNK: MatchChunk = { rest: "", ok: false, bad: true };

/**
 * Go's `matchChunk`: match the all-single-char-operators `chunk` against the
 * start of `s`. Once the match fails the loop keeps walking `chunk` (no longer
 * reading `s`) so a malformed pattern is still reported.
 */
const matchChunk = (chunkIn: string, sIn: string): MatchChunk => {
  let chunk = chunkIn;
  let s = sIn;
  let failed = false;
  while (chunk.length > 0) {
    if (!failed && s.length === 0) failed = true;
    const op = chunk[0];
    if (op === "[") {
      let r = 0;
      if (!failed) {
        r = s.codePointAt(0)!;
        s = s.slice(runeWidth(r));
      }
      chunk = chunk.slice(1);
      let negated = false;
      if (chunk.length > 0 && chunk[0] === "^") {
        negated = true;
        chunk = chunk.slice(1);
      }
      let match = false;
      let nrange = 0;
      for (;;) {
        if (chunk.length > 0 && chunk[0] === "]" && nrange > 0) {
          chunk = chunk.slice(1);
          break;
        }
        const lo = getEsc(chunk);
        if (lo.bad) return BAD_CHUNK;
        chunk = lo.rest;
        let hi = lo.r;
        if (chunk[0] === "-") {
          const hiEsc = getEsc(chunk.slice(1));
          if (hiEsc.bad) return BAD_CHUNK;
          chunk = hiEsc.rest;
          hi = hiEsc.r;
        }
        if (lo.r <= r && r <= hi) match = true;
        nrange++;
      }
      if (match === negated) failed = true;
    } else if (op === "?") {
      if (!failed) {
        const cp = s.codePointAt(0)!;
        if (cp === 0x2f) failed = true; // '/'
        s = s.slice(runeWidth(cp));
      }
      chunk = chunk.slice(1);
    } else if (op === "\\") {
      chunk = chunk.slice(1);
      if (chunk.length === 0) return BAD_CHUNK;
      if (!failed) {
        if (chunk[0] !== s[0]) failed = true;
        s = s.slice(1);
      }
      chunk = chunk.slice(1);
    } else {
      if (!failed) {
        if (chunk[0] !== s[0]) failed = true;
        s = s.slice(1);
      }
      chunk = chunk.slice(1);
    }
  }
  return failed ? { rest: "", ok: false, bad: false } : { rest: s, ok: true, bad: false };
};

/**
 * Reports whether `name` matches the shell pattern `pattern`, using Go's
 * `path.Match` semantics. `badPattern` is set (instead of throwing) when the
 * pattern is malformed, mirroring Go's `path.ErrBadPattern`.
 */
export const legacyPathMatch = (pattern: string, name: string): LegacyPathMatchResult => {
  let pat = pattern;
  let nm = name;
  while (pat.length > 0) {
    const scan = scanChunk(pat);
    pat = scan.rest;
    if (scan.star && scan.chunk === "") {
      // Trailing `*` matches the rest of the name unless it contains a `/`.
      return { matched: !nm.includes("/"), badPattern: false };
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
      // Look for a match skipping one code point at a time; `*` cannot cross `/`.
      let advanced = false;
      for (let i = 0; i < nm.length && nm[i] !== "/"; i++) {
        const skip = matchChunk(scan.chunk, nm.slice(i + 1));
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
      if (matchChunk(tail.chunk, "").bad) return BAD_PATTERN;
    }
    return { matched: false, badPattern: false };
  }
  return { matched: nm.length === 0, badPattern: false };
};
