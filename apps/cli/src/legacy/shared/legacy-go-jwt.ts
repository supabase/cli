import { createHmac, createPrivateKey, createSign } from "node:crypto";
import { encodeGoJsonCompact } from "./legacy-go-json.ts";

/**
 * RFC 7517 JWK fields `JWK` struct round-trips (`pkg/config/auth.go:88-108`,
 * `toml`/`json` tags `kty`, `kid`, `use`, `key_ops`, `alg`, `ext`, `n`, `e`, `d`, `p`, `q`, `dp`,
 * `dq`, `qi`, `crv`, `x`, `y`) — field names match exactly, so a signing-keys file can be parsed
 * straight into this shape (Go decodes `auth.signing_keys_path` directly into `[]JWK`,
 * `pkg/config/config.go:1113`, so `use`/`key_ops`/`ext` on a user's key file must round-trip into
 * both `GOTRUE_JWT_KEYS` and the published JWKS just like every other field here). A superset of
 * Node's own `crypto.webcrypto.JsonWebKey` (which omits `kid`), so it's still assignable wherever
 * that type is expected (e.g. `createPrivateKey`'s `format: "jwk"` input) — `key_ops` is typed as
 * a mutable `string[]` rather than `ReadonlyArray<string>` for exactly this reason: Node's own
 * `JsonWebKey.key_ops` field is a plain `string[]`, and a `ReadonlyArray` isn't assignable to it.
 */
export interface LegacyJwk {
  readonly kty: string;
  readonly kid?: string;
  readonly use?: string;
  readonly key_ops?: string[];
  readonly alg?: string;
  readonly ext?: boolean;
  readonly n?: string;
  readonly e?: string;
  readonly d?: string;
  readonly p?: string;
  readonly q?: string;
  readonly dp?: string;
  readonly dq?: string;
  readonly qi?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
}

/**
 * `NewConfig()` default `Auth.SigningKeys` —
 * a single ES256 key, unconditionally present on every resolved config UNLESS overwritten by a
 * real `auth.signing_keys_path` file (and only then when `auth.enabled` — see
 * `config.go:1087,1110-1116`). `ResolveJWKS` iterates `a.SigningKeys` regardless of
 * `auth.enabled`, so this default key is always part of the published JWKS unless a configured
 * file overrides it — callers must not skip it just because auth happens to be disabled or no
 * `signing_keys_path` is set. Shared by GoTrue's own env building (`services/gotrue.service.ts`,
 * which signs tokens with it) and JWKS resolution (`legacyResolveLocalJwks`, which must publish
 * its public form) so the two can never disagree on the default key.
 *
 * Typed as `LegacyJwk` directly — see that type's own doc comment for why `key_ops` is a mutable
 * `string[]` rather than `ReadonlyArray<string>`, which is also why this is still structurally
 * assignable everywhere a `JwkLike` (`shared/auth/jwks.ts`) is expected.
 */
export const LEGACY_DEFAULT_SIGNING_KEY: LegacyJwk = {
  kty: "EC",
  kid: "b81269f1-21d8-4f2e-b719-c2240a840d90",
  use: "sig",
  key_ops: ["sign", "verify"],
  alg: "ES256",
  ext: true,
  crv: "P-256",
  x: "M5Sjqn5zwC9Kl1zVfUUGvv9boQjCGd45G8sdopBExB4",
  y: "P6IXMvA2WYXSHSOMTBH2jsw_9rrzGy89FjPf6oOsIxQ",
  d: "dIhR8wywJlqlua4y_yMq2SLhlFXDZJBCvFrY1DCHyVU",
};

/**
 * Go-byte-exact HS256 signer for the default local-dev `anon`/`service_role`
 * keys, ported from `CustomClaims`/`generateJWT`.
 * {@link legacyGenerateAsymmetricGoJwt} below covers the RS256/ES256 branch of
 * the same Go function, taken when `auth.signing_keys_path` is configured.
 *
 * This intentionally does NOT reuse `@supabase/stack`'s `generateJwt`
 * (`packages/stack/src/JwtGenerator.ts`) — that helper uses `iss:"supabase"`,
 * a dynamic `iat`/10-year `exp`, and a different claim order, none of which
 * byte-match what Go prints for `supabase status`. Go's claims, in
 * declaration order (the outer `CustomClaims.Issuer` field shadows the
 * embedded `jwt.RegisteredClaims.Issuer`, so only one `iss` key is emitted):
 *
 * iss (fixed "supabase-demo"), ref (omitempty), role, is_anonymous (omitempty),
 * then the remaining `jwt.RegisteredClaims` fields (sub, aud, exp, nbf, iat, jti),
 * all `omitempty` except `exp`, which Go always sets to the fixed
 * `defaultJwtExpiry = 1983812996` unix timestamp (never computed from "now").
 *
 * `status` never sets `ref`/`is_anonymous`, so for this signer's two roles the
 * payload always serializes to exactly `{"iss":...,"role":...,"exp":...}`.
 */

const GO_JWT_ISSUER = "supabase-demo";
const GO_JWT_FIXED_EXP = 1983812996;

function base64UrlEncode(input: string): string {
  return Buffer.from(input).toString("base64url");
}

export function legacyGenerateGoJwt(secret: string, role: "anon" | "service_role"): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({ iss: GO_JWT_ISSUER, role, exp: GO_JWT_FIXED_EXP }),
  );
  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

/** Go's asymmetric-JWT expiry: `time.Now().Add(time.Hour * 24 * 365 * 10)` (10 years). */
const GO_JWT_ASYMMETRIC_EXPIRY_SECONDS = 60 * 60 * 24 * 365 * 10;

function base64UrlToBigInt(value: string): bigint {
  const hex = Buffer.from(value, "base64url").toString("hex");
  return hex.length === 0 ? 0n : BigInt(`0x${hex}`);
}

function bigIntToBase64Url(value: bigint): string {
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  return Buffer.from(hex, "hex").toString("base64url");
}

/** Modular inverse of `a` mod `m` via the extended Euclidean algorithm (`a`/`m` coprime, as `q`/`p` always are for a valid RSA key). */
function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [a, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const quotient = oldR / r;
    [oldR, r] = [r, oldR - quotient * r];
    [oldS, s] = [s, oldS - quotient * s];
  }
  return ((oldS % m) + m) % m;
}

/**
 * Backfills the RSA CRT parameters (`dp`, `dq`, `qi`) `jwkToRSAPrivateKey`
 * never reads — it constructs
 * `rsa.PrivateKey{N, E, D, Primes: [p, q]}` from `n`/`e`/`d`/`p`/`q` alone, and
 * Go's stdlib `crypto/rsa` (`SignPKCS1v15` -> `precompute()`) lazily derives
 * `Dp`/`Dq`/`Qinv` from `p`/`q`/`d` itself when they're absent, so a JWK
 * missing them still signs successfully in Go. Node's
 * `createPrivateKey({ format: "jwk" })` has no such fallback — it hard-rejects
 * an RSA JWK without `dp`/`dq`/`qi` (`The "key.dp" property must be of type
 * string`) — so this reproduces Go's derivation before handing the key to
 * Node: `dp = d mod (p-1)`, `dq = d mod (q-1)`, `qi = q^-1 mod p` (RFC 7517
 * section 6.3.2 / RFC 3447 section 3.2). A key that already has all three (the common case
 * for a Node/openssl-generated JWK) is returned unchanged; one missing
 * `d`/`p`/`q` themselves is also returned unchanged — that's a genuinely
 * invalid key in Go too, and `createPrivateKey` will raise its own error.
 */
function ensureRsaCrtParams(jwk: LegacyJwk): LegacyJwk {
  if (jwk.dp !== undefined && jwk.dq !== undefined && jwk.qi !== undefined) {
    return jwk;
  }
  if (jwk.d === undefined || jwk.p === undefined || jwk.q === undefined) {
    return jwk;
  }
  const d = base64UrlToBigInt(jwk.d);
  const p = base64UrlToBigInt(jwk.p);
  const q = base64UrlToBigInt(jwk.q);
  return {
    ...jwk,
    dp: bigIntToBase64Url(d % (p - 1n)),
    dq: bigIntToBase64Url(d % (q - 1n)),
    qi: bigIntToBase64Url(modInverse(q, p)),
  };
}

type LegacySupportedJwtAlgorithm = "RS256" | "ES256";

/**
 * `config.Algorithm.UnmarshalText` —
 * `encoding/json` calls this automatically whenever a JWK's `alg` field decodes from
 * a JSON STRING (the only shape a pasted stdin JWK or a `signing_keys_path` file ever
 * provides), rejecting anything other than `RS256`/`ES256` at JSON-DECODE time — well
 * BEFORE the JWK ever reaches signing. An absent `alg` never reaches this check at
 * all (`encoding/json` only calls `UnmarshalText` for a key present in the source
 * JSON; a missing key just leaves the struct field at its zero value), so that case
 * is caught later, at SIGN time, by {@link legacySignJwtWithJwk}'s own `unsupported
 * algorithm: ` check instead. Throws Go's own bare `UnmarshalText` error text
 * unwrapped; callers apply their own decode-context wrapping (`"failed to parse
 * JWK: %w"` for a pasted stdin JWK, `"failed to decode signing keys: failed to parse
 * response body: %w"` for a `signing_keys_path` file — see `fetcher.ParseJSON`,
 * `apps/cli-go/pkg/fetcher/http.go:144-151`).
 */
export function legacyAssertDecodableJwkAlgorithm(alg: string | undefined): void {
  if (alg !== undefined && alg !== "RS256" && alg !== "ES256") {
    throw new Error("must be one of [RS256 ES256]");
  }
}

/**
 * `jwkToPrivateKey`: validates
 * `jwk.kty`/`jwk.crv` ONLY — it has no awareness of `jwk.alg` at all. Throws Go's
 * own unwrapped message text; the caller ({@link legacySignJwtWithJwk}) applies
 * `GenerateAsymmetricJWT`'s `"failed to convert JWK to private key: %w"` wrapper
 * on top.
 */
function assertSupportedKty(jwk: LegacyJwk): void {
  if (jwk.kty === "EC") {
    if (jwk.crv !== "P-256") {
      throw new Error(`unsupported curve: ${jwk.crv ?? ""}`);
    }
    return;
  }
  if (jwk.kty !== "RSA") {
    throw new Error(`unsupported key type: ${jwk.kty ?? ""}`);
  }
}

/**
 * `jwkToECDSAPrivateKey`/`jwkToRSAPrivateKey`
 * decode every numeric field with `base64.RawURLEncoding.DecodeString` immediately after the
 * kty/curve check above — and that decoder genuinely REJECTS `=`-padded input (`RawURLEncoding`
 * has no pad character at all), unlike Node's own JWK importer
 * (`createPrivateKey({format:"jwk"})`), which happily accepts a padded coordinate and signs a
 * token Go would have refused to produce (verified empirically: Go's decoder raises
 * `illegal base64 data at input byte 43` for a padded 32-byte P-256 coordinate; Node's importer
 * raises nothing at all and returns a usable key) — CLI-1961 Codex review finding.
 *
 * Runs in Go's exact per-field order (EC: x, y, d; RSA: n, e, d, p, q) so the FIRST invalid field
 * matches Go's own first-failure-wins decode order. Reproduces
 * `encoding/base64`'s `CorruptInputError` text exactly: the reported byte offset is the index of
 * the first character outside the `RawURLEncoding` alphabet (`A-Za-z0-9-_` — a padding `=` is
 * such a character, since this encoding has no pad character to special-case), or
 * `value.length - 1` for an otherwise-valid string whose length is impossible for base64
 * (`length % 4 === 1`) — both verified directly against the Go standard library's
 * `decodeQuantum`. An absent field is Go's own zero value (`""`), which decodes cleanly to zero
 * bytes, so `undefined` is skipped here rather than treated as invalid.
 */
function assertDecodableJwkNumericFields(jwk: LegacyJwk): void {
  const assertField = (label: string, value: string | undefined): void => {
    if (value === undefined) return;
    for (let i = 0; i < value.length; i++) {
      if (!/^[A-Za-z0-9_-]$/.test(value[i]!)) {
        throw new Error(`failed to decode ${label}: illegal base64 data at input byte ${i}`);
      }
    }
    if (value.length % 4 === 1) {
      throw new Error(
        `failed to decode ${label}: illegal base64 data at input byte ${value.length - 1}`,
      );
    }
  };
  if (jwk.kty === "EC") {
    assertField("x coordinate", jwk.x);
    assertField("y coordinate", jwk.y);
    assertField("private key", jwk.d);
    return;
  }
  assertField("modulus", jwk.n);
  assertField("exponent", jwk.e);
  assertField("private exponent", jwk.d);
  assertField("first prime factor", jwk.p);
  assertField("second prime factor", jwk.q);
}

/**
 * Go has NO explicit cross-check between `jwk.Algorithm` and `jwk.KeyType` before
 * signing: `jwkToPrivateKey` only validates kty/curve (see {@link assertSupportedKty}),
 * and `GenerateAsymmetricJWT`'s algorithm switch only validates `jwk.Algorithm`
 * itself. A mismatched pair (e.g. `kty: "RSA"` signed as `ES256`) reaches
 * `token.SignedString(privateKey)` and fails INSIDE golang-jwt's own signing
 * method, which type-asserts the key (jwt/v5@v5.3.1 `rsa.go:76` / `ecdsa.go:99`):
 * `"key is of invalid type: <detail>"`, wrapped by `apikeys.go:113` into
 * `"failed to sign JWT: %w"`. Node's own `createSign(...).sign(privateKey)` would
 * also fail on this mismatch, but with an OpenSSL-level message that does not
 * match Go's text — so this reproduces Go's OBSERVABLE error deliberately, ahead
 * of ever touching Node's signer.
 */
function assertKeyMatchesAlgorithm(jwk: LegacyJwk, algorithm: LegacySupportedJwtAlgorithm): void {
  if (algorithm === "RS256" && jwk.kty !== "RSA") {
    throw new Error("key is of invalid type: RSA sign expects *rsa.PrivateKey");
  }
  if (algorithm === "ES256" && jwk.kty !== "EC") {
    throw new Error("key is of invalid type: ECDSA sign expects *ecdsa.PrivateKey");
  }
}

/**
 * Go's `GenerateAsymmetricJWT`: signs an
 * already-encoded JSON claims payload with a JWK private key. Callers own their
 * own claims shape/serialization (struct-field order for
 * {@link legacyGenerateAsymmetricGoJwt}'s fixed anon/service_role claims, Go
 * map-key alphabetical order for `gen bearer-jwt`'s `jwt.MapClaims`-shaped
 * claims) — this function only handles the parts Go's `GenerateAsymmetricJWT`
 * itself handles: key validation, header construction, and signing.
 *
 * Validation order matches Go exactly: kty/curve first (wrapped
 * `"failed to convert JWK to private key: %w"`, {@link assertSupportedKty}),
 * then the algorithm switch (unwrapped `"unsupported algorithm: %s"`), then the
 * kty-vs-alg mismatch Go's OWN signing method raises (wrapped
 * `"failed to sign JWT: %w"`, {@link assertKeyMatchesAlgorithm}). The header key
 * order (`alg`, `kid`, `typ`) matches `encoding/json` alphabetically
 * sorting `map[string]interface{}` keys — `kid` is only present when set on the
 * JWK, matching `if len(jwk.KeyID) > 0` guard.
 *
 * `dsaEncoding: "ieee-p1363"` is required for ES256: Node's default ECDSA
 * signature output is DER-encoded, which is not the raw (r‖s) format JWS
 * requires — verified by round-tripping through `jose`'s `jwtVerify`.
 *
 * The header is serialized with {@link encodeGoJsonCompact}, NOT `JSON.stringify` — Go's
 * `token.SignedString` marshals the header via `encoding/json`'s default `json.Marshal`
 * (`golang-jwt/jwt/v5`'s `Token.SigningString`), which HTML-escapes `<`/`>`/`&` (verified
 * directly against the Go standard library: `json.Marshal` of a `kid` containing those
 * characters produces `<`/`>`/`&`, where `JSON.stringify` leaves them literal) —
 * a `kid` with any of those characters would otherwise sign different header bytes (and thus a
 * different signature) than Go for identical input (CLI-1961 Codex review finding).
 */
export function legacySignJwtWithJwk(jwk: LegacyJwk, payloadJson: string): string {
  try {
    assertSupportedKty(jwk);
    assertDecodableJwkNumericFields(jwk);
  } catch (cause) {
    throw new Error(
      `failed to convert JWK to private key: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const algorithm = jwk.alg;
  if (algorithm !== "RS256" && algorithm !== "ES256") {
    throw new Error(`unsupported algorithm: ${algorithm ?? ""}`);
  }

  try {
    assertKeyMatchesAlgorithm(jwk, algorithm);
  } catch (cause) {
    throw new Error(
      `failed to sign JWT: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const header =
    jwk.kid !== undefined && jwk.kid.length > 0
      ? { alg: algorithm, kid: jwk.kid, typ: "JWT" }
      : { alg: algorithm, typ: "JWT" };
  const headerEncoded = base64UrlEncode(encodeGoJsonCompact(header));
  const payloadEncoded = base64UrlEncode(payloadJson);
  const data = `${headerEncoded}.${payloadEncoded}`;

  const privateKey = createPrivateKey({
    key: algorithm === "RS256" ? ensureRsaCrtParams(jwk) : jwk,
    format: "jwk",
  });
  const signature =
    algorithm === "RS256"
      ? createSign("RSA-SHA256").update(data).end().sign(privateKey)
      : createSign("sha256")
          .update(data)
          .end()
          .sign({ key: privateKey, dsaEncoding: "ieee-p1363" });

  return `${data}.${signature.toString("base64url")}`;
}

/**
 * Go's `(a auth) generateJWT` asymmetric branch,
 * reached only when `auth.signing_keys_path` resolves to a non-empty JWK array —
 * the first key in the file signs both the anon and service_role tokens. Same
 * claim shape as {@link legacyGenerateGoJwt} (`iss`/`role`/`exp`), except the
 * expiry is 10 years from now rather than Go's fixed HMAC-path timestamp, since
 * `generateJWT` sets `claims.ExpiresAt` explicitly before calling
 * `GenerateAsymmetricJWT` with a `CustomClaims` STRUCT value (not a map) —
 * `encoding/json` serializes a struct in field-DECLARATION order, so this
 * builds the payload with a plain (insertion-order) `JSON.stringify`, unlike
 * `gen bearer-jwt`'s claims (always a real `jwt.MapClaims`, alphabetically
 * key-sorted — see `bearer-jwt.claims.ts`).
 */
export function legacyGenerateAsymmetricGoJwt(
  jwk: LegacyJwk,
  role: "anon" | "service_role",
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + GO_JWT_ASYMMETRIC_EXPIRY_SECONDS;
  return legacySignJwtWithJwk(jwk, JSON.stringify({ iss: GO_JWT_ISSUER, role, exp: expiresAt }));
}
