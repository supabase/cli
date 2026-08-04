import { Option } from "effect";
import { encodeGoStructJsonBody } from "../../../shared/legacy-go-output.encoders.ts";
import { legacyGoJsonKindName } from "../../../shared/legacy-go-json.ts";

/**
 * Pure claims-building logic for `gen bearer-jwt`, ported from Go's `parseClaims`
 * (`apps/cli-go/cmd/gen.go:185-213`). Kept out of the handler/service tree (no `Effect`,
 * no service dependencies) per `apps/cli/CLAUDE.md`'s `.format.ts`/`.encoders.ts`
 * guidance — this is exactly that shape of file, just named `.claims.ts` for this command.
 *
 * Go's real call site (`cmd/gen.go:137-141`) ALWAYS builds a `jwt.MapClaims` (a genuine Go
 * map) and hands it to `bearerjwt.Run` — never a `CustomClaims` struct. `encoding/json`
 * serializes a map's keys in SORTED (alphabetical) order, unlike a struct's
 * declaration order — see {@link legacyEncodeBearerJwtClaims}, which every caller MUST use
 * to serialize the object this module builds (a plain `JSON.stringify` would preserve
 * insertion order instead, which is Go-correct for `legacyGenerateAsymmetricGoJwt`'s
 * struct-shaped claims but wrong here).
 */

export interface LegacyBearerJwtClaimsInput {
  readonly role: string;
  readonly sub: Option.Option<string>;
  /** Unix seconds from `--exp` (RFC3339) — `Option.none()` when the flag was not given. */
  readonly expiresAt: Option.Option<number>;
  /**
   * `--valid-for`, parsed from Go-duration syntax into seconds WITHOUT flooring —
   * see {@link legacyParseBearerJwtValidFor}'s own doc comment for why sub-second
   * precision must survive until the final `exp`/`iat` computation below.
   */
  readonly validForSeconds: number;
  /** `Date.now()`-derived Unix seconds, injected so callers (and tests) control "now". */
  readonly nowSeconds: number;
}

/**
 * Go's time/role computation (`cmd/gen.go:187-198`):
 *   - `--exp` unset (zero `time.Time`): `iat = now`, `exp = now + validFor`.
 *   - `--exp` set: `exp = <parsed --exp>`, `iat = exp - validFor` (validFor is SUBTRACTED
 *     from the explicit expiry to derive `iat`, not added to `now`).
 *   - Both arithmetic branches use Go's exact-nanosecond `time.Time` math and only floor
 *     the FINAL `exp`/`iat` to whole seconds via `jwt.NewNumericDate`'s `Truncate`
 *     (`golang-jwt/jwt/v5`'s `types.go:38-40`) — so `validForSeconds` (which may carry
 *     sub-second precision, see {@link LegacyBearerJwtClaimsInput.validForSeconds}) must
 *     be applied BEFORE flooring, not floored first and then applied. Verified against
 *     the real binary (CLI-1961): `--exp 2030-01-01T00:00:00Z --valid-for 1.5s` yields
 *     `iat=1893455998` — flooring the 1.5s duration to 1s first (as this port previously
 *     did) would wrongly yield `1893455999`.
 *   - `role` is ALWAYS present (`json:"role"`, no `omitempty`), even `--role ""`.
 *   - `is_anonymous` is set only when `role` case-insensitively equals `"authenticated"`
 *     AND `--sub` was not given (`strings.EqualFold` + `len(claims.Subject) == 0`) — an
 *     explicitly-passed EMPTY `--sub ""` still counts as "not given" for this specific
 *     check (`len("") == 0`), even though the `sub` claim omission below is governed by
 *     the SAME emptiness check, not by whether the flag was passed at all; the `role`
 *     claim keeps its original casing regardless.
 *   - `sub`/`exp`/`iat` all carry Go's embedded `jwt.RegisteredClaims` `omitempty` tags —
 *     `sub` only when non-empty, `exp`/`iat` always (both are always-set `*NumericDate`s
 *     here, matching mapstructure's non-nil-pointer handling — see `legacy-go-jwt.ts`'s
 *     sibling doc comments for the general `omitempty`-in-mapstructure background).
 *   - `iss`/`ref`/`aud`/`nbf`/`jti` never appear — bearer-jwt has no flag that sets any of
 *     them, so they stay at their Go zero value and get `omitempty`-dropped.
 */
export function legacyBuildBearerJwtClaims(
  input: LegacyBearerJwtClaimsInput,
): Record<string, unknown> {
  let exp: number;
  let iat: number;
  if (Option.isNone(input.expiresAt)) {
    iat = input.nowSeconds;
    exp = Math.floor(iat + input.validForSeconds);
  } else {
    exp = input.expiresAt.value;
    iat = Math.floor(exp - input.validForSeconds);
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

const GO_JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"]);

function skipGoJsonWhitespace(value: string, index: number): number {
  let i = index;
  while (i < value.length && GO_JSON_WHITESPACE.has(value[i]!)) i++;
  return i;
}

/**
 * Index right after the closing (unescaped) `"` of the JSON string starting at
 * `value[start]` (assumed to be `"`), or `undefined` when it never closes —
 * Go's scanner likewise just bails out to `"unexpected end of JSON input"` on a
 * truncated string, so escape-sequence CORRECTNESS doesn't need validating here.
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

/** Go's literal keywords, keyed by their first byte — matched char-by-char below, same as `encoding/json`'s scanner. */
const GO_JSON_LITERALS: Record<string, string> = { n: "null", t: "true", f: "false" };

/**
 * Reports Go's exact `"invalid character '<c>' after top-level value"` when
 * `trimmed` has non-whitespace content after its first `validPrefixLength`
 * characters, or the generic fallback when there is none — reachable only via a
 * leading byte JS's `\s` regex strips but Go's scanner does not treat as
 * whitespace (e.g. a vertical tab), so the ORIGINAL `JSON.parse(payload)` call
 * still failed even though `trimmed` alone is one complete, valid JSON value.
 */
function reportGoJsonTrailingGarbage(trimmed: string, validPrefixLength: number): string {
  const restStart = skipGoJsonWhitespace(trimmed, validPrefixLength);
  if (restStart >= trimmed.length) {
    return "invalid character looking for beginning of value";
  }
  return `invalid character '${trimmed[restStart]}' after top-level value`;
}

/**
 * Best-effort, single-pass (no repeated whole-string `JSON.parse` retries — see
 * below) reproduction of Go's `encoding/json` scanner syntax-error text for a
 * malformed `--payload` value, verified against the real binary (CLI-1961) for
 * every shape covered here: an empty/whitespace-only payload or a genuinely
 * truncated value (`"unexpected end of JSON input"`), a byte that can never start
 * a JSON value (`"invalid character '<c>' looking for beginning of value"`), a
 * partial keyword match (`"invalid character '<c>' in literal <word> (expecting
 * '<c2>')"`, e.g. `--payload 'not-json-at-all'` starts with `n` looking like
 * `null`), and valid JSON followed by trailing garbage (`"invalid character '<c>'
 * after top-level value"`, e.g. `--payload '{}{}'`).
 *
 * Dispatches on the first non-whitespace byte rather than building a full
 * recursive-descent parser — each of the five shapes above only needs to know
 * "where does the first top-level value end, and how did the byte after it (or
 * the byte that broke a literal/number) fail" — and every helper below scans
 * forward only, so a large malformed payload cannot make this pathological the
 * way retrying `JSON.parse` on shrinking prefixes could. Genuinely malformed
 * JSON with no recognizable failure shape above (e.g. a lone `-` with no digits)
 * falls back to a generic message that is NOT verified byte-for-byte against
 * Go's own scanner (accepted gap — `bearerjwt_test.go` has no fixture for
 * `--payload` parsing at all; see this command's own audit notes).
 */
function legacyGoJsonSyntaxErrorMessage(raw: string): string {
  const trimmed = raw.replace(/^\s+/, "");
  if (trimmed.length === 0) {
    return "unexpected end of JSON input";
  }

  const first = trimmed[0]!;

  const literal = GO_JSON_LITERALS[first];
  if (literal !== undefined) {
    for (let i = 0; i < literal.length; i++) {
      if (i >= trimmed.length) {
        return "unexpected end of JSON input";
      }
      if (trimmed[i] !== literal[i]) {
        return `invalid character '${trimmed[i]}' in literal ${literal} (expecting '${literal[i]}')`;
      }
    }
    return reportGoJsonTrailingGarbage(trimmed, literal.length);
  }

  if (first === '"') {
    const end = findJsonStringEnd(trimmed, 0);
    return end === undefined
      ? "unexpected end of JSON input"
      : reportGoJsonTrailingGarbage(trimmed, end);
  }

  if (first === "{" || first === "[") {
    const end = findJsonContainerEnd(trimmed, 0);
    return end === undefined
      ? "unexpected end of JSON input"
      : reportGoJsonTrailingGarbage(trimmed, end);
  }

  if (first === "-" || (first >= "0" && first <= "9")) {
    const match = JSON_NUMBER_PATTERN.exec(trimmed);
    if (match === null || match[0].length === 0) {
      // Only reachable for a lone, digit-less `-` — Go's scanner is still
      // mid-number waiting for a digit when the input runs out.
      return "unexpected end of JSON input";
    }
    return reportGoJsonTrailingGarbage(trimmed, match[0].length);
  }

  return `invalid character '${first}' looking for beginning of value`;
}

/**
 * Go's final `--payload` merge (`cmd/gen.go:209-211`):
 * `json.Unmarshal([]byte(payload), &custom)`. `encoding/json` reuses the existing
 * non-nil map and overwrites/adds keys from the payload on top — so this merges
 * `JSON.parse(payload)`'s own keys OVER `claims` (payload wins on any collision,
 * e.g. `--payload '{"role":"override"}'` replaces the flag-derived `role`).
 *
 * A JSON `null` payload is a no-op — verified against the real binary — rather than
 * clearing `claims` (Go's own map-into-map unmarshal semantics for a `null` source
 * leave the destination untouched here in practice). A non-object, non-null,
 * non-array top-level scalar (string/number/bool) or an array raises Go's own
 * `"json: cannot unmarshal <kind> into Go value of type jwt.MapClaims"` runtime
 * type-mismatch text. Throws a bare `Error`; the caller (`bearer-jwt.handler.ts`)
 * wraps it with Go's `"failed to parse payload: %w"` prefix.
 */
export function legacyMergeBearerJwtPayload(
  claims: Record<string, unknown>,
  payload: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error(legacyGoJsonSyntaxErrorMessage(payload));
  }
  if (parsed === null) {
    return claims;
  }
  if (Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(
      `json: cannot unmarshal ${legacyGoJsonKindName(parsed)} into Go value of type jwt.MapClaims`,
    );
  }
  return { ...claims, ...(parsed as Record<string, unknown>) };
}

/**
 * Serializes the final claims object the way Go's `jwt.MapClaims` (a real Go map)
 * marshals via `encoding/json`: alphabetically key-sorted at every level, Go's HTML +
 * control-character escaping, no indentation, no trailing newline. Reuses
 * `encodeGoStructJsonBody` (originally written for outbound API request bodies) —
 * its behavior is Go's generic `json.Marshal`-of-a-map shape, which is exactly what a
 * `jwt.MapClaims` payload needs too; introducing a second identical encoder under a
 * different name would just be a rename, not a behavior difference.
 */
export function legacyEncodeBearerJwtClaims(claims: Record<string, unknown>): string {
  return encodeGoStructJsonBody(claims);
}
