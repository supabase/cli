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
 * Backfills the RSA CRT parameters (`dp`, `dq`, `qi`) Go's `jwkToRSAPrivateKey`
 * (`apps/cli-go/pkg/config/apikeys.go:132-168`) never reads — it constructs
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
 * (RSA/EC key types) + this function's own switch on `jwk.alg`. `kty`/`alg`
 * are cross-validated (RS256 requires `kty: "RSA"`, ES256 requires
 * `kty: "EC"` and `crv: "P-256"`) — matching Go's `jwkToRSAPrivateKey` /
 * `jwkToECDSAPrivateKey`, which reject any other combination rather than
 * signing with a mismatched key or curve (Node's `createPrivateKey`/`createSign`
 * do not themselves catch this: an EC key signed as RS256, or a non-P-256
 * curve signed as ES256, both "succeed" and produce a spec-invalid token that
 * silently fails verification instead of raising an error). The header key
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
  if (algorithm === "RS256" && jwk.kty !== "RSA") {
    throw new Error(`unsupported key type: ${jwk.kty}`);
  }
  if (algorithm === "ES256") {
    if (jwk.kty !== "EC") {
      throw new Error(`unsupported key type: ${jwk.kty}`);
    }
    if (jwk.crv !== "P-256") {
      throw new Error(`unsupported curve: ${jwk.crv ?? ""}`);
    }
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
