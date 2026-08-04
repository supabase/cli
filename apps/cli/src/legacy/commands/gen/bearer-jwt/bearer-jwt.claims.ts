import { Option } from "effect";
import { encodeGoStructJsonBody } from "../../../shared/legacy-go-output.encoders.ts";

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
  /** `--valid-for`, already parsed from Go-duration syntax into whole seconds. */
  readonly validForSeconds: number;
  /** `Date.now()`-derived Unix seconds, injected so callers (and tests) control "now". */
  readonly nowSeconds: number;
}

/**
 * Go's time/role computation (`cmd/gen.go:187-198`):
 *   - `--exp` unset (zero `time.Time`): `iat = now`, `exp = now + validFor`.
 *   - `--exp` set: `exp = <parsed --exp>`, `iat = exp - validFor` (validFor is SUBTRACTED
 *     from the explicit expiry to derive `iat`, not added to `now`).
 *   - `role` is ALWAYS present (`json:"role"`, no `omitempty`), even `--role ""`.
 *   - `is_anonymous` is set only when `role` case-insensitively equals `"authenticated"`
 *     AND `--sub` was not given (`strings.EqualFold` + `len(claims.Subject) == 0`); the
 *     `role` claim keeps its original casing regardless.
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
    exp = iat + input.validForSeconds;
  } else {
    exp = input.expiresAt.value;
    iat = exp - input.validForSeconds;
  }

  const claims: Record<string, unknown> = {
    role: input.role,
  };
  if (input.role.toLowerCase() === "authenticated" && Option.isNone(input.sub)) {
    claims["is_anonymous"] = true;
  }
  if (Option.isSome(input.sub) && input.sub.value.length > 0) {
    claims["sub"] = input.sub.value;
  }
  claims["exp"] = exp;
  claims["iat"] = iat;
  return claims;
}

/**
 * Go's `encoding/json` type names for the JSON-representable kinds `json.Unmarshal`
 * rejects. Shared with `bearer-jwt.signing-key.ts`'s Branch A (a pasted stdin JWK that
 * decodes to a non-object) — both need Go's exact `"json: cannot unmarshal <kind>
 * into Go value of type <target>"` wording, just against different target types
 * (`jwt.MapClaims` here, `config.JWK` there).
 */
export function legacyGoJsonKindName(value: unknown): string {
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "bool";
    default:
      return "value";
  }
}

/**
 * Best-effort reproduction of Go's `encoding/json` scanner syntax-error text for a
 * malformed `--payload` value. Handles the two shapes verified against the real binary
 * (CLI-1961): an empty/whitespace-only payload (`"unexpected end of JSON input"`), and
 * valid JSON followed by trailing garbage (`"invalid character 'X' after top-level
 * value"`, found by growing the longest parseable prefix) — this covers `--payload
 * '{}{}'` exactly. Genuinely malformed JSON with NO valid prefix at all (e.g. a bare
 * unquoted identifier) falls back to a generic message that is NOT verified
 * byte-for-byte against Go's own scanner (accepted gap — `bearerjwt_test.go` has no
 * fixture for `--payload` parsing at all; see this command's own audit notes).
 */
function legacyGoJsonSyntaxErrorMessage(raw: string): string {
  const trimmed = raw.replace(/^\s+/, "");
  if (trimmed.length === 0) {
    return "unexpected end of JSON input";
  }
  for (let end = trimmed.length; end > 0; end--) {
    const candidate = trimmed.slice(0, end);
    try {
      JSON.parse(candidate);
    } catch {
      continue;
    }
    const rest = trimmed.slice(end).replace(/^\s+/, "");
    if (rest.length === 0) break;
    return `invalid character '${rest[0]}' after top-level value`;
  }
  return "invalid character looking for beginning of value";
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
