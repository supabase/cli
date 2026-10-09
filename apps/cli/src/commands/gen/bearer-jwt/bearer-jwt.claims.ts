import { Option } from "effect";
import { encodeSortedJsonBody } from "../../../command-internal/output.encoders.ts";
import { jsonKindName } from "../../../command-internal/html-safe-json.ts";
import { addSecondsAndFloor, type BearerJwtInstant } from "./bearer-jwt.flags.ts";

/**
 * Pure claims-building logic for `gen bearer-jwt` (no Effect, no service
 * dependencies).
 *
 * The claims object is a map, so it must be serialized via
 * {@link encodeBearerJwtClaims}, which key-sorts
 * like a map — `JSON.stringify` would wrongly preserve insertion order.
 */

export interface BearerJwtClaimsInput {
  readonly role: string;
  readonly sub: Option.Option<string>;
  /**
   * The parsed `--exp` instant (RFC3339), unfloored; `Option.none()` when the
   * flag was not given. See {@link BearerJwtInstant} for why this can't be a
   * single float.
   */
  readonly expiresAt: Option.Option<BearerJwtInstant>;
  /**
   * `--valid-for`, parsed from duration syntax into seconds, unfloored —
   * see {@link parseBearerJwtValidFor} for why sub-second precision must
   * survive until the final `exp`/`iat` computation.
   */
  readonly validForSeconds: number;
  /**
   * `Date.now()`-derived instant, injected so callers (and tests) control
   * "now"; not pre-floored to whole seconds. Flooring it before this module
   * sees it would compute `exp` from an already-truncated `now`, shortening
   * the token's lifetime by up to a second whenever `--valid-for` has a
   * sub-second component.
   */
  readonly nowInstant: BearerJwtInstant;
}

/**
 * `--exp` unset: `iat = now`, `exp = now + validFor`; `--exp` set: `exp` is
 * the parsed value, `iat = exp - validFor`. Both floor only the final
 * `exp`/`iat` via {@link addSecondsAndFloor}, so sub-second precision
 * survives until then. `is_anonymous` is set only when `role` is
 * case-insensitively "authenticated" and `sub` is empty (including `""`).
 */
export function buildBearerJwtClaims(input: BearerJwtClaimsInput): Record<string, unknown> {
  let exp: number;
  let iat: number;
  if (Option.isNone(input.expiresAt)) {
    iat = input.nowInstant.wholeSeconds;
    exp = addSecondsAndFloor(input.nowInstant, input.validForSeconds);
  } else {
    const rawExp = input.expiresAt.value;
    exp = rawExp.wholeSeconds;
    iat = addSecondsAndFloor(rawExp, -input.validForSeconds);
  }

  const claims: Record<string, unknown> = {
    role: input.role,
  };
  const sub = Option.getOrUndefined(input.sub);
  const subIsEmpty = sub === undefined || sub.length === 0;
  if (input.role.toLowerCase() === "authenticated" && subIsEmpty) {
    claims["is_anonymous"] = true;
  }
  if (!subIsEmpty) {
    claims["sub"] = sub;
  }
  claims["exp"] = exp;
  claims["iat"] = iat;
  return claims;
}

const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

function skipJsonWhitespace(value: string, index: number): number {
  let i = index;
  while (i < value.length && JSON_WHITESPACE.has(value[i]!)) i++;
  return i;
}

/**
 * Index right after the closing (unescaped) `"` of the JSON string starting
 * at `value[start]`, or `undefined` when it never closes. Escape-sequence
 * validity doesn't matter here, since a truncated string always reports
 * "unexpected end of JSON input" regardless.
 */
function findJsonStringEnd(value: string, start: number): number | undefined {
  let i = start + 1;
  while (i < value.length) {
    if (value[i] === "\\") {
      i += 2;
      continue;
    }
    if (value[i] === '"') {
      return i + 1;
    }
    i++;
  }
  return undefined;
}

/**
 * Index right after the closing `}`/`]` that matches the `{`/`[` at `value[start]`,
 * tracking bracket depth while skipping over string literals (so a bracket
 * character inside a string never perturbs the count) — or `undefined` when depth
 * never returns to zero (truncated/unterminated).
 */
function findJsonContainerEnd(value: string, start: number): number | undefined {
  let depth = 0;
  let i = start;
  while (i < value.length) {
    const ch = value[i];
    if (ch === '"') {
      const stringEnd = findJsonStringEnd(value, i);
      if (stringEnd === undefined) return undefined;
      i = stringEnd;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return undefined;
}

const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

/** Literal keywords, keyed by their first byte; matched char-by-char below. */
const JSON_LITERALS: Record<string, string> = { n: "null", t: "true", f: "false" };

/**
 * Finds the first JSON number literal in an already-valid JSON document that
 * overflows a float64 (e.g. `1e309`), or `undefined` if none does.
 *
 * `JSON.parse` silently converts an overflowing literal to `Infinity`, but
 * decoding into `jwt.MapClaims` must fail instead, so `mergeBearerJwtPayload`
 * uses this to reproduce that failure. A single left-to-right scan (skipping
 * string contents via {@link findJsonStringEnd}) is enough, since only a full
 * number-token match at a digit/`-` position needs checking.
 */
function findFirstNonFiniteJsonNumberLiteral(value: string): string | undefined {
  let i = 0;
  while (i < value.length) {
    const ch = value[i]!;
    if (ch === '"') {
      // Known-valid JSON, so every string closes; skip it whole so its
      // digits are never mistaken for a number token.
      i = findJsonStringEnd(value, i)!;
      continue;
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const literal = JSON_NUMBER_PATTERN.exec(value.slice(i))![0];
      if (!Number.isFinite(Number(literal))) {
        return literal;
      }
      i += literal.length;
      continue;
    }
    i++;
  }
  return undefined;
}

/**
 * Reports `"invalid character '<c>' after top-level value"` when `trimmed`
 * has non-whitespace content after `validPrefixLength`, or the generic
 * fallback otherwise — reachable when a leading byte (e.g. a vertical tab)
 * is whitespace to JS's `\s` regex but not to this scanner.
 */
function reportJsonTrailingGarbage(trimmed: string, validPrefixLength: number): string {
  const restStart = skipJsonWhitespace(trimmed, validPrefixLength);
  if (restStart >= trimmed.length) {
    return "invalid character looking for beginning of value";
  }
  return `invalid character '${trimmed[restStart]}' after top-level value`;
}

/**
 * Produces the scanner syntax-error text for a malformed
 * `--payload` value: truncated input, an invalid leading byte, a partial
 * keyword match, or trailing garbage after valid JSON.
 *
 * Dispatches on the first non-whitespace byte and scans forward only, rather
 * than parsing recursively or retrying `JSON.parse` on shrinking prefixes. An
 * unrecognized shape (e.g. a lone `-`) falls back to a generic, unverified
 * message.
 */
function jsonSyntaxErrorMessage(raw: string): string {
  const trimmed = raw.replace(/^\s+/, "");
  if (trimmed.length === 0) {
    return "unexpected end of JSON input";
  }

  const first = trimmed[0]!;

  const literal = JSON_LITERALS[first];
  if (literal !== undefined) {
    for (let i = 0; i < literal.length; i++) {
      if (i >= trimmed.length) {
        return "unexpected end of JSON input";
      }
      if (trimmed[i] !== literal[i]) {
        return `invalid character '${trimmed[i]}' in literal ${literal} (expecting '${literal[i]}')`;
      }
    }
    return reportJsonTrailingGarbage(trimmed, literal.length);
  }

  if (first === '"') {
    const end = findJsonStringEnd(trimmed, 0);
    return end === undefined
      ? "unexpected end of JSON input"
      : reportJsonTrailingGarbage(trimmed, end);
  }

  if (first === "{" || first === "[") {
    const end = findJsonContainerEnd(trimmed, 0);
    return end === undefined
      ? "unexpected end of JSON input"
      : reportJsonTrailingGarbage(trimmed, end);
  }

  if (first === "-" || (first >= "0" && first <= "9")) {
    const match = JSON_NUMBER_PATTERN.exec(trimmed);
    if (match === null || match[0].length === 0) {
      // Only reachable for a lone, digit-less `-`: the scanner is still
      // mid-number when the input runs out.
      return "unexpected end of JSON input";
    }
    return reportJsonTrailingGarbage(trimmed, match[0].length);
  }

  return `invalid character '${first}' looking for beginning of value`;
}

/**
 * Merges a parsed `--payload` JSON object over `claims`, payload values
 * winning on any key collision. A JSON `null` payload is a no-op.
 *
 * A non-object top-level value raises a type-mismatch error before
 * any number-overflow scan runs; only once the top level is an object does
 * an overflowing number anywhere inside it raise the float64-overflow error
 * from {@link findFirstNonFiniteJsonNumberLiteral}. Throws a bare `Error`,
 * which the caller wraps with a `"failed to parse payload: <cause>"` prefix.
 */
export function mergeBearerJwtPayload(
  claims: Record<string, unknown>,
  payload: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error(jsonSyntaxErrorMessage(payload));
  }
  if (parsed === null) {
    return claims;
  }
  if (Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`invalid claims: expected a JSON object, got ${jsonKindName(parsed)}`);
  }
  const overflowingLiteral = findFirstNonFiniteJsonNumberLiteral(payload);
  if (overflowingLiteral !== undefined) {
    throw new Error(`invalid claims: number ${overflowingLiteral} is out of range`);
  }
  return { ...claims, ...(parsed as Record<string, unknown>) };
}

/**
 * Serializes claims as a map:
 * alphabetically key-sorted at every level, HTML + control-character
 * escaping, no indentation or trailing newline. Reuses
 * `encodeSortedJsonBody`, since a map's marshalled shape is identical
 * regardless of what produced it.
 */
export function encodeBearerJwtClaims(claims: Record<string, unknown>): string {
  return encodeSortedJsonBody(claims);
}
