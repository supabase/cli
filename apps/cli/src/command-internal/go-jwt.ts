import { createHmac, createPrivateKey, createSign } from "node:crypto";
import { encodeGoJsonCompact } from "./go-json.ts";

/**
 * An RFC 7517 JWK, with fields matching `auth.signing_keys_path`'s JSON/TOML key format so a
 * user's signing key file round-trips into `GOTRUE_JWT_KEYS` and the published JWKS unchanged.
 *
 * A superset of Node's `crypto.webcrypto.JsonWebKey` (which omits `kid`), so still assignable
 * wherever that type is expected (e.g. `createPrivateKey`'s `format: "jwk"` input); `key_ops` is a
 * mutable `string[]` to match Node's own field type.
 */
export interface Jwk {
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
 * The default ES256 signing key present on every resolved config unless overridden by a real
 * `auth.signing_keys_path` file. Always part of the published JWKS regardless of `auth.enabled`.
 * Shared by GoTrue's own env building (which signs tokens with it) and JWKS resolution (which
 * publishes its public form), so the two can never disagree on the default key.
 */
export const DEFAULT_SIGNING_KEY: Jwk = {
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
 * HS256 signer for the default local-dev `anon`/`service_role` keys. {@link
 * generateAsymmetricGoJwt} below covers the RS256/ES256 branch, taken when
 * `auth.signing_keys_path` is configured.
 *
 * Does not reuse `@supabase/stack`'s `generateJwt`: that helper uses a different issuer, a
 * dynamic expiry, and a different claim order. This signer's payload always serializes to exactly
 * `{"iss":"supabase-demo","role":...,"exp":1983812996}` — a fixed expiry, never computed from
 * "now".
 */

const GO_JWT_ISSUER = "supabase-demo";
const GO_JWT_FIXED_EXP = 1983812996;

function base64UrlEncode(input: string): string {
  return Buffer.from(input).toString("base64url");
}

export function generateGoJwt(secret: string, role: "anon" | "service_role"): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({ iss: GO_JWT_ISSUER, role, exp: GO_JWT_FIXED_EXP }),
  );
  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

/** Asymmetric-JWT expiry: 10 years from now. */
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

/** Modular inverse of `a` mod `m` via the extended Euclidean algorithm (`q`/`p` are always coprime for a valid RSA key). */
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
 * Backfills the RSA CRT parameters (`dp`, `dq`, `qi`) when absent: Node's `createPrivateKey`
 * rejects an RSA JWK without them, unlike Go, which derives them lazily from `p`/`q`/`d` before
 * signing. Returns the key unchanged if all three are already present, or if `d`/`p`/`q` are
 * missing (an invalid key either way).
 */
function ensureRsaCrtParams(jwk: Jwk): Jwk {
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

type SupportedJwtAlgorithm = "RS256" | "ES256";

/**
 * Validates a JWK's `alg` field, rejecting anything other than `RS256`/`ES256`. An absent `alg`
 * is not rejected here — that's caught later, at sign time, by {@link signJwtWithJwk}'s own
 * `unsupported algorithm: ` check. Throws the bare error text; callers apply their own
 * decode-context wrapping.
 */
export function assertDecodableJwkAlgorithm(alg: string | undefined): void {
  if (alg !== undefined && alg !== "RS256" && alg !== "ES256") {
    throw new Error("must be one of [RS256 ES256]");
  }
}

/**
 * Validates `jwk.kty`/`jwk.crv` only — no awareness of `jwk.alg`. Throws the established error
 * text; the caller ({@link signJwtWithJwk}) wraps it further.
 */
function assertSupportedKty(jwk: Jwk): void {
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
 * Reproduces `encoding/base64`'s `CorruptInputError` message for each numeric field, since Go's
 * unpadded base64 decoder rejects input Node's own JWK importer would silently accept (e.g. a
 * `=`-padded coordinate) and sign a token Go could never have produced.
 *
 * Checks fields in Go's exact order (EC: x, y, d; RSA: n, e, d, p, q) so the first invalid field
 * matches Go's first-failure-wins order. An absent field is skipped, matching Go's zero value
 * decoding to zero bytes.
 */
function assertDecodableJwkNumericFields(jwk: Jwk): void {
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
 * There's no explicit cross-check between a JWK's type and its signing algorithm before signing
 * (see {@link assertSupportedKty}). A mismatched pair (e.g. `kty: "RSA"` signed as `ES256`) must
 * fail with this exact message rather than Node's own OpenSSL-level error, which wouldn't match
 * it.
 */
function assertKeyMatchesAlgorithm(jwk: Jwk, algorithm: SupportedJwtAlgorithm): void {
  if (algorithm === "RS256" && jwk.kty !== "RSA") {
    throw new Error("key is of invalid type: RSA sign expects *rsa.PrivateKey");
  }
  if (algorithm === "ES256" && jwk.kty !== "EC") {
    throw new Error("key is of invalid type: ECDSA sign expects *ecdsa.PrivateKey");
  }
}

/**
 * Signs an already-encoded JSON claims payload with a JWK private key. Header key order is `alg`,
 * `kid` (only when set), `typ`.
 *
 * `dsaEncoding: "ieee-p1363"` is required for ES256: Node's default ECDSA signature is
 * DER-encoded, not the raw (r‖s) format JWS requires. The header is serialized with
 * {@link encodeGoJsonCompact}, not `JSON.stringify`, since a `kid` containing `<`/`>`/`&` must
 * HTML-escape to sign the same bytes Go would.
 */
export function signJwtWithJwk(jwk: Jwk, payloadJson: string): string {
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
 * The RS256/ES256 signing path, used when `auth.signing_keys_path` resolves to a non-empty JWK
 * array — the first key in the file signs both the anon and service_role tokens. Same claim
 * shape as {@link generateGoJwt} (`iss`/`role`/`exp`), except the expiry is 10 years from now.
 */
export function generateAsymmetricGoJwt(jwk: Jwk, role: "anon" | "service_role"): string {
  const expiresAt = Math.floor(Date.now() / 1000) + GO_JWT_ASYMMETRIC_EXPIRY_SECONDS;
  return signJwtWithJwk(jwk, JSON.stringify({ iss: GO_JWT_ISSUER, role, exp: expiresAt }));
}
