import { createHmac, createPrivateKey, createSign } from "node:crypto";

/**
 * RFC 7517 JWK fields Go's `JWK` struct round-trips (`pkg/config/auth.go:88-108`,
 * `toml`/`json` tags `kty`, `kid`, `alg`, `n`, `e`, `d`, `p`, `q`, `dp`, `dq`,
 * `qi`, `crv`, `x`, `y`) — field names match exactly, so a signing-keys file can
 * be parsed straight into this shape. A superset of Node's own
 * `crypto.webcrypto.JsonWebKey` (which omits `kid`), so it's still assignable
 * wherever that type is expected (e.g. `createPrivateKey`'s `format: "jwk"` input).
 */
export interface LegacyJwk {
  readonly kty: string;
  readonly kid?: string;
  readonly alg?: string;
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
 * Go-byte-exact HS256 signer for the default local-dev `anon`/`service_role`
 * keys, ported from `CustomClaims`/`generateJWT` (`apps/cli-go/pkg/config/apikeys.go:23-40,75-86`).
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
 *   iss (fixed "supabase-demo"), ref (omitempty), role, is_anonymous (omitempty),
 *   then the remaining `jwt.RegisteredClaims` fields (sub, aud, exp, nbf, iat, jti),
 *   all `omitempty` except `exp`, which Go always sets to the fixed
 *   `defaultJwtExpiry = 1983812996` unix timestamp (never computed from "now").
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

/**
 * Go's `GenerateAsymmetricJWT` (`pkg/config/apikeys.go:88-113`), reached from
 * `generateJWT` only when `auth.signing_keys_path` resolves to a non-empty JWK
 * array (`pkg/config/apikeys.go:76-80`) — the first key in the file signs both
 * the anon and service_role tokens. Same claim shape as {@link legacyGenerateGoJwt}
 * (`iss`/`role`/`exp`), except the expiry is 10 years from now rather than Go's
 * fixed HMAC-path timestamp, since `generateJWT` sets `claims.ExpiresAt`
 * explicitly before calling this function instead of falling through to
 * `CustomClaims.NewToken()`'s fixed default.
 *
 * Only `RS256`/`ES256` are supported, matching Go's `jwkToPrivateKey`
 * (RSA/EC key types) + this function's own switch on `jwk.alg`. The header key
 * order (`alg`, `kid`, `typ`) matches Go's `encoding/json` alphabetically
 * sorting `map[string]interface{}` keys — `kid` is only present when set on
 * the JWK, matching Go's `if len(jwk.KeyID) > 0` guard.
 *
 * `dsaEncoding: "ieee-p1363"` is required for ES256: Node's default ECDSA
 * signature output is DER-encoded, which is not the raw (r‖s) format JWS
 * requires — verified by round-tripping through `jose`'s `jwtVerify`.
 */
export function legacyGenerateAsymmetricGoJwt(
  jwk: LegacyJwk,
  role: "anon" | "service_role",
): string {
  const algorithm = jwk.alg;
  if (algorithm !== "RS256" && algorithm !== "ES256") {
    throw new Error(`unsupported algorithm: ${algorithm ?? ""}`);
  }
  const header =
    jwk.kid !== undefined && jwk.kid.length > 0
      ? { alg: algorithm, kid: jwk.kid, typ: "JWT" }
      : { alg: algorithm, typ: "JWT" };
  const expiresAt = Math.floor(Date.now() / 1000) + GO_JWT_ASYMMETRIC_EXPIRY_SECONDS;
  const headerEncoded = base64UrlEncode(JSON.stringify(header));
  const payloadEncoded = base64UrlEncode(
    JSON.stringify({ iss: GO_JWT_ISSUER, role, exp: expiresAt }),
  );
  const data = `${headerEncoded}.${payloadEncoded}`;

  const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
  const signature =
    algorithm === "RS256"
      ? createSign("RSA-SHA256").update(data).end().sign(privateKey)
      : createSign("sha256")
          .update(data)
          .end()
          .sign({ key: privateKey, dsaEncoding: "ieee-p1363" });

  return `${data}.${signature.toString("base64url")}`;
}
