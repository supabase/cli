/**
 * Storage URL parsing, ported 1:1 from Go's `internal/storage/client/scheme.go`
 * plus the slices of `net/url` that `url.Parse` exercises for the `ss://` scheme.
 *
 * Two layers:
 *  - `legacyGoUrlParse` reproduces Go's `url.Parse` for the fields the storage
 *    commands read (`Scheme`, `Host`, `Path`) and the parse errors they surface
 *    (`missing protocol scheme`, malformed `%` escape, control byte). `cp` parses
 *    `src`/`dst` with this directly (Go uses `url.Parse`, not `ParseStorageURL`).
 *  - `legacyParseStorageUrl` is Go's `ParseStorageURL`: parse, then require
 *    scheme `ss` (case-insensitive), a non-empty path, and no host.
 *
 * Kept pure (no Effect, no command-specific tagged errors) so the handlers map
 * the thrown errors to their own `Legacy*` tagged errors and the parser stays
 * unit-testable against `scheme_test.go`.
 */

/** Go `client.STORAGE_SCHEME` (`scheme.go:10`). */
export const LEGACY_STORAGE_SCHEME = "ss";

/** Go `client.ErrInvalidURL` message (`scheme.go:12`). */
const LEGACY_STORAGE_INVALID_URL_MESSAGE = "URL must match pattern ss:///bucket/[prefix]";

/**
 * Thrown when `legacyGoUrlParse` fails, mirroring Go's `*url.Error`:
 * `parse "<url>": <inner>` (`net/url.Error.Error`). Callers wrap `.message` in
 * their own `failed to parse … url: <message>` text, matching Go's
 * `errors.Errorf("failed to parse … url: %w", err)`.
 */
export class LegacyGoUrlParseError extends Error {
  constructor(rawURL: string, inner: string) {
    super(`parse "${rawURL}": ${inner}`);
    this.name = "LegacyGoUrlParseError";
  }
}

/**
 * Thrown when a URL parses but does not match the `ss:///bucket/[prefix]`
 * pattern (Go's `ErrInvalidURL`). Distinct from `LegacyGoUrlParseError` so the
 * handler can map it to `LegacyStorageUrlPatternError` rather than the
 * parse-error tagged error.
 */
export class LegacyStorageUrlPatternError extends Error {
  constructor() {
    super(LEGACY_STORAGE_INVALID_URL_MESSAGE);
    this.name = "LegacyStorageUrlPatternError";
  }
}

export interface LegacyGoUrl {
  /** Lowercased scheme (Go lowercases via `strings.ToLower`); `""` when none. */
  readonly scheme: string;
  /** Authority host (after `//`); `""` when absent. */
  readonly host: string;
  /** Unescaped path (Go `url.Path`); `""` when the URL is opaque/host-only. */
  readonly path: string;
}

function isAlpha(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a);
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

/** Go `net/url.stringContainsCTLByte` (`url.go`). */
function containsCtlByte(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const b = s.charCodeAt(i);
    if ((b < 0x20 && b !== 0x09) || b === 0x7f) return true;
  }
  return false;
}

/**
 * Go `net/url.getScheme`: a scheme is `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`
 * terminated by `:`. A leading non-alpha, or any out-of-grammar byte before the
 * first `:`, means there is no scheme (the whole input is the rest). A leading
 * `:` is the `missing protocol scheme` error.
 */
function getScheme(rawURL: string): { scheme: string; rest: string } {
  for (let i = 0; i < rawURL.length; i++) {
    const c = rawURL.charCodeAt(i);
    if (isAlpha(c)) {
      continue;
    }
    if (isDigit(c) || c === 0x2b /* + */ || c === 0x2d /* - */ || c === 0x2e /* . */) {
      if (i === 0) return { scheme: "", rest: rawURL };
      continue;
    }
    if (c === 0x3a /* : */) {
      if (i === 0) throw new Error("missing protocol scheme");
      return { scheme: rawURL.slice(0, i), rest: rawURL.slice(i + 1) };
    }
    // Invalid character before any `:` → no scheme.
    return { scheme: "", rest: rawURL };
  }
  return { scheme: "", rest: rawURL };
}

function isHex(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);
}

function unhex(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return c - 0x41 + 10;
}

/**
 * Go `net/url.unescape(s, encodePath)`: decode `%XX` sequences, erroring on a
 * malformed escape (`invalid URL escape "%XY"`). In `encodePath` mode `+` is
 * literal.
 *
 * Go decodes `%XX` to raw bytes and the resulting `Path` is a byte string that,
 * for a UTF-8 source, reads as the Unicode runes. To match, consecutive `%XX`
 * bytes are collected and decoded as a single UTF-8 run (`%E4%B8%AD` → `中`, not
 * three per-byte code points); literal characters pass through unchanged.
 */
function unescapePath(s: string): string {
  if (!s.includes("%")) return s;
  let out = "";
  let pending: Array<number> = [];
  const flushPending = () => {
    if (pending.length > 0) {
      out += new TextDecoder().decode(new Uint8Array(pending));
      pending = [];
    }
  };
  for (let i = 0; i < s.length; ) {
    if (s.charCodeAt(i) === 0x25 /* % */) {
      const h1 = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      const h2 = i + 2 < s.length ? s.charCodeAt(i + 2) : -1;
      if (i + 2 >= s.length || h1 < 0 || h2 < 0 || !isHex(h1) || !isHex(h2)) {
        const bad = s.slice(i, Math.min(i + 3, s.length));
        throw new Error(`invalid URL escape "${bad}"`);
      }
      pending.push(unhex(h1) * 16 + unhex(h2));
      i += 3;
    } else {
      flushPending();
      out += s[i];
      i += 1;
    }
  }
  flushPending();
  return out;
}

/** Go `net/url` authority host extraction (userinfo split at the last `@`). */
function hostFromAuthority(authority: string): string {
  const at = authority.lastIndexOf("@");
  return at === -1 ? authority : authority.slice(at + 1);
}

/**
 * Port of Go's `url.Parse` restricted to `Scheme`/`Host`/`Path`. Throws
 * `LegacyGoUrlParseError` (Go's `*url.Error`) on the failures the storage
 * commands can hit. Query (`?…`) and fragment (`#…`) are stripped exactly as Go
 * splits them, though storage URLs never use them.
 */
export function legacyGoUrlParse(rawURL: string): LegacyGoUrl {
  // Go `Parse` cuts the fragment before calling the internal `parse`.
  const hashIdx = rawURL.indexOf("#");
  const u = hashIdx === -1 ? rawURL : rawURL.slice(0, hashIdx);

  if (containsCtlByte(u)) {
    throw new LegacyGoUrlParseError(u, "net/url: invalid control character in URL");
  }
  if (u === "*") {
    return { scheme: "", host: "", path: "*" };
  }

  let scheme: string;
  let rest: string;
  try {
    const parsed = getScheme(u);
    scheme = parsed.scheme.toLowerCase();
    rest = parsed.rest;
  } catch (cause) {
    throw new LegacyGoUrlParseError(u, cause instanceof Error ? cause.message : String(cause));
  }

  // Strip the query (Go: `rest, RawQuery, _ = strings.Cut(rest, "?")`).
  const qIdx = rest.indexOf("?");
  if (qIdx !== -1) rest = rest.slice(0, qIdx);

  if (!rest.startsWith("/")) {
    if (scheme !== "") {
      // Rootless path → opaque; Path stays empty.
      return { scheme, host: "", path: "" };
    }
    // Non-request, no scheme: a colon in the first segment is rejected.
    const slash = rest.indexOf("/");
    const segment = slash === -1 ? rest : rest.slice(0, slash);
    if (segment.includes(":")) {
      throw new LegacyGoUrlParseError(u, "first path segment in URL cannot contain colon");
    }
  }

  let host = "";
  // Go: enter authority parsing only when (scheme set OR not "///"-prefixed) AND "//"-prefixed.
  if ((scheme !== "" || !rest.startsWith("///")) && rest.startsWith("//")) {
    const afterSlashes = rest.slice(2);
    const slash = afterSlashes.indexOf("/");
    const authority = slash === -1 ? afterSlashes : afterSlashes.slice(0, slash);
    rest = slash === -1 ? "" : afterSlashes.slice(slash);
    host = hostFromAuthority(authority);
  }

  let path: string;
  try {
    path = unescapePath(rest);
  } catch (cause) {
    throw new LegacyGoUrlParseError(u, cause instanceof Error ? cause.message : String(cause));
  }
  return { scheme, host, path };
}

/**
 * Go `client.ParseStorageURL` (`scheme.go:14-23`): parse, then require scheme
 * `ss` (case-insensitive), a non-empty path, and no host. Returns the path.
 * Throws `LegacyGoUrlParseError` on a url-parse failure (wrapped by the caller
 * as `failed to parse storage url: …`) or `LegacyStorageUrlPatternError` when
 * the parsed URL doesn't match the `ss:///bucket/[prefix]` pattern.
 */
export function legacyParseStorageUrl(objectURL: string): string {
  const parsed = legacyGoUrlParse(objectURL);
  if (
    parsed.scheme !== LEGACY_STORAGE_SCHEME ||
    parsed.path.length === 0 ||
    parsed.host.length > 0
  ) {
    throw new LegacyStorageUrlPatternError();
  }
  return parsed.path;
}

/**
 * Go `client.SplitBucketPrefix` (`scheme.go:25-38`): `/bucket/folder/x` →
 * `["bucket", "folder/x"]`; `/bucket/` / `/bucket` / `bucket` → `["bucket", ""]`;
 * `""` / `"/"` → `["", ""]`.
 */
export function legacySplitBucketPrefix(objectPath: string): readonly [string, string] {
  if (objectPath === "" || objectPath === "/") {
    return ["", ""];
  }
  const start = objectPath.charCodeAt(0) === 0x2f /* / */ ? 1 : 0;
  const sep = objectPath.indexOf("/", start);
  if (sep < 0) {
    return [objectPath.slice(start), ""];
  }
  return [objectPath.slice(start, sep), objectPath.slice(sep + 1)];
}

/**
 * Lowercased scheme for a raw URL, mirroring `cp`'s
 * `strings.EqualFold(parsed.Scheme, STORAGE_SCHEME)` branch input. `""` when the
 * URL has no scheme (a local path). Throws `LegacyGoUrlParseError` on a malformed
 * URL (e.g. `:`), exactly as `cp`'s `url.Parse` does.
 */
export function legacyDetectScheme(rawURL: string): string {
  return legacyGoUrlParse(rawURL).scheme;
}

/**
 * Go `cp.IsDir` (`cp.go:174-176`): an object prefix is a directory when it is
 * empty or ends with `/`.
 */
export function legacyStorageIsDir(objectPrefix: string): boolean {
  return objectPrefix.length === 0 || objectPrefix.endsWith("/");
}

/**
 * Go `path.Split`: split after the final slash into `[dir, file]`, where `dir`
 * keeps its trailing slash. `folder/name.png` → `["folder/", "name.png"]`;
 * `dir` → `["", "dir"]`; `tmp/` → `["tmp/", ""]`; `""` → `["", ""]`. Used by the
 * gateway's `listObjects` query (`pkg/storage/objects.go:46`) and the recursive
 * walk's base-path computation (`internal/storage/ls/ls.go:97`).
 */
export function legacyGoPathSplit(p: string): readonly [string, string] {
  const i = p.lastIndexOf("/");
  return [p.slice(0, i + 1), p.slice(i + 1)];
}
