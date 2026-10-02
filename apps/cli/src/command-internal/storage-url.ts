import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityFingerprintId,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

/**
 * Storage URL parsing, matching Go's `net/url.Parse` semantics for the `ss://`
 * scheme. `goUrlParse` implements `net/url.Parse` for the fields storage
 * commands need (scheme, host, path); `parseStorageUrl` additionally requires
 * scheme `ss` (case-insensitive), a non-empty path, and no host.
 *
 * Kept pure (no Effect) so handlers can map the thrown errors to their own
 * tagged errors.
 */

export const STORAGE_SCHEME = "ss";

const STORAGE_INVALID_URL_MESSAGE = "URL must match pattern ss:///bucket/[prefix]";

/**
 * Thrown when `goUrlParse` fails: `parse "<url>": <inner>`. Callers wrap
 * `.message` in their own `failed to parse … url: <message>` text.
 */
export class GoUrlParseError extends Error {
  static readonly [ErrorActionabilityFingerprintId] = "GoUrlParseError";
  constructor(rawURL: string, inner: string) {
    super(`parse "${rawURL}": ${inner}`);
    this.name = "GoUrlParseError";
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Thrown when a URL parses but does not match the `ss:///bucket/[prefix]`
 * pattern. Distinct from `GoUrlParseError` so handlers can map it to a
 * separate tagged error.
 */
export class StorageUrlPatternError extends Error {
  static readonly [ErrorActionabilityFingerprintId] = "StorageUrlPatternError";
  constructor() {
    super(STORAGE_INVALID_URL_MESSAGE);
    this.name = "StorageUrlPatternError";
  }

  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export interface GoUrl {
  /** Lowercased scheme; `""` when none. */
  readonly scheme: string;
  /** Authority host (after `//`); `""` when absent. */
  readonly host: string;
  /** Unescaped path; `""` when the URL is opaque/host-only. */
  readonly path: string;
}

function isAlpha(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a);
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

/** Whether `s` contains a control byte (other than tab). */
function containsCtlByte(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const b = s.charCodeAt(i);
    if ((b < 0x20 && b !== 0x09) || b === 0x7f) return true;
  }
  return false;
}

/**
 * A scheme is `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )` terminated by `:`.
 * A leading non-alpha, or any out-of-grammar byte before the first `:`, means
 * there is no scheme. A leading `:` is the `missing protocol scheme` error.
 */
function getScheme(rawURL: string): { scheme: string; rest: string } {
  for (let i = 0; i < rawURL.length; i++) {
    const c = rawURL.charCodeAt(i);
    if (isAlpha(c)) {
      continue;
    }
    if (isDigit(c) || c === 0x2b /* + */ || c === 0x2d /* - */ || c === 0x2e /*. */) {
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
 * Decodes `%XX` sequences, erroring on a malformed escape (`invalid URL
 * escape "%XY"`). Consecutive `%XX` bytes are collected and decoded together
 * as a single UTF-8 run (`%E4%B8%AD` → `中`, not three separate code points).
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
  for (let i = 0; i < s.length;) {
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

/** Authority host: userinfo split at the last `@`. */
function hostFromAuthority(authority: string): string {
  const at = authority.lastIndexOf("@");
  return at === -1 ? authority : authority.slice(at + 1);
}

/** `""`, or `:` followed by only digits. */
function isValidOptionalPort(port: string): boolean {
  if (port.length === 0) return true;
  if (port.charCodeAt(0) !== 0x3a /* : */) return false;
  for (let i = 1; i < port.length; i++) {
    if (!isDigit(port.charCodeAt(i))) return false;
  }
  return true;
}

/**
 * Validates IP-literal (`[...]`) bracket/port syntax and `host[:port]`
 * port-digit checks, matching Go's host validation for realistic inputs but
 * skipping bracketed-literal IP-address checks and IPv6 zone-id decoding.
 * http/https treat the first colon as the port separator; other schemes use
 * the last.
 */
function validateGoUrlHost(scheme: string, host: string): void {
  if (host.length === 0) return;
  const openBracketIdx = host.indexOf("[");
  if (openBracketIdx > 0) {
    throw new Error("invalid IP-literal");
  }
  if (openBracketIdx === 0) {
    const closeBracketIdx = host.lastIndexOf("]");
    if (closeBracketIdx < 0) {
      throw new Error("missing ']' in host");
    }
    const colonPort = host.slice(closeBracketIdx + 1);
    if (!isValidOptionalPort(colonPort)) {
      throw new Error(`invalid port ${JSON.stringify(colonPort)} after host`);
    }
    return;
  }
  const colonIdx =
    scheme === "http" || scheme === "https" ? host.indexOf(":") : host.lastIndexOf(":");
  if (colonIdx !== -1) {
    const colonPort = host.slice(colonIdx);
    if (!isValidOptionalPort(colonPort)) {
      throw new Error(`invalid port ${JSON.stringify(colonPort)} after host`);
    }
  }
}

/**
 * Parses a URL for `scheme`/`host`/`path`, matching Go's `net/url.Parse`.
 * Throws `GoUrlParseError` on parse failure. Query and fragment are stripped,
 * though storage URLs never use them.
 */
export function goUrlParse(rawURL: string): GoUrl {
  const hashIdx = rawURL.indexOf("#");
  const u = hashIdx === -1 ? rawURL : rawURL.slice(0, hashIdx);

  if (containsCtlByte(u)) {
    throw new GoUrlParseError(u, "net/url: invalid control character in URL");
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
    throw new GoUrlParseError(u, cause instanceof Error ? cause.message : String(cause));
  }

  // Strip the query string.
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
      throw new GoUrlParseError(u, "first path segment in URL cannot contain colon");
    }
  }

  let host = "";
  // Skip authority parsing for a schemeless triple-slash prefix ("///x") —
  // that's a path, not an authority.
  if ((scheme !== "" || !rest.startsWith("///")) && rest.startsWith("//")) {
    const afterSlashes = rest.slice(2);
    const slash = afterSlashes.indexOf("/");
    const authority = slash === -1 ? afterSlashes : afterSlashes.slice(0, slash);
    rest = slash === -1 ? "" : afterSlashes.slice(slash);
    host = hostFromAuthority(authority);
    try {
      validateGoUrlHost(scheme, host);
    } catch (cause) {
      throw new GoUrlParseError(u, cause instanceof Error ? cause.message : String(cause));
    }
  }

  let path: string;
  try {
    path = unescapePath(rest);
  } catch (cause) {
    throw new GoUrlParseError(u, cause instanceof Error ? cause.message : String(cause));
  }
  return { scheme, host, path };
}

/**
 * Parses a storage URL, requiring scheme `ss` (case-insensitive), a
 * non-empty path, and no host, and returns the path. Throws
 * `GoUrlParseError` on a parse failure, or `StorageUrlPatternError` when it
 * doesn't match `ss:///bucket/[prefix]`.
 */
export function parseStorageUrl(objectURL: string): string {
  const parsed = goUrlParse(objectURL);
  if (parsed.scheme !== STORAGE_SCHEME || parsed.path.length === 0 || parsed.host.length > 0) {
    throw new StorageUrlPatternError();
  }
  return parsed.path;
}

/**
 * Splits an object path into `[bucket, prefix]`: `/bucket/folder/x` →
 * `["bucket", "folder/x"]`; `/bucket/`, `/bucket`, `bucket` → `["bucket", ""]`;
 * `""`, `"/"` → `["", ""]`.
 */
export function splitBucketPrefix(objectPath: string): readonly [string, string] {
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
 * Lowercased scheme for a raw URL; `""` when the URL has no scheme (a local
 * path). Throws `GoUrlParseError` on a malformed URL (e.g. `:`).
 */
export function detectScheme(rawURL: string): string {
  return goUrlParse(rawURL).scheme;
}

/** An object prefix is a directory when it is empty or ends with `/`. */
export function storageIsDir(objectPrefix: string): boolean {
  return objectPrefix.length === 0 || objectPrefix.endsWith("/");
}

/**
 * Splits after the final slash into `[dir, file]`, where `dir` keeps its
 * trailing slash: `folder/name.png` → `["folder/", "name.png"]`; `dir` →
 * `["", "dir"]`; `tmp/` → `["tmp/", ""]`; `""` → `["", ""]`.
 */
export function goPathSplit(p: string): readonly [string, string] {
  const i = p.lastIndexOf("/");
  return [p.slice(0, i + 1), p.slice(i + 1)];
}
