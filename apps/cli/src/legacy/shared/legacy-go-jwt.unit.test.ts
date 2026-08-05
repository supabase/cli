import { createHmac, generateKeyPairSync } from "node:crypto";
import { importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";

import {
  legacyAssertDecodableJwkAlgorithm,
  legacyGenerateAsymmetricGoJwt,
  legacyGenerateGoJwt,
  legacySignJwtWithJwk,
  type LegacyJwk,
} from "./legacy-go-jwt.ts";

const SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";

function generateRsaJwk(kid?: string): LegacyJwk {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" });
  return { ...jwk, kty: "RSA", alg: "RS256", kid };
}

function generateEcJwk(kid?: string): LegacyJwk {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  return { ...jwk, kty: "EC", alg: "ES256", kid };
}

function publicJwkOf(jwk: LegacyJwk): LegacyJwk {
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...publicJwk } = jwk;
  return publicJwk;
}

function decodeSegment(segment: string): string {
  return Buffer.from(segment, "base64url").toString("utf8");
}

describe("legacyGenerateGoJwt", () => {
  it("emits Go's exact JWT header (no extra fields, alg before typ)", () => {
    const token = legacyGenerateGoJwt(SECRET, "anon");
    const [header] = token.split(".");
    expect(header).toBeDefined();
    // Go's jwt.NewWithClaims builds Header as map[string]any{"typ":..,"alg":..};
    // encoding/json marshals map keys in sorted order, so "alg" sorts before "typ".
    expect(decodeSegment(header ?? "")).toBe('{"alg":"HS256","typ":"JWT"}');
  });

  it("emits the anon payload with Go's exact key order and fixed claims", () => {
    const token = legacyGenerateGoJwt(SECRET, "anon");
    const [, payload] = token.split(".");
    expect(payload).toBeDefined();
    const raw = decodeSegment(payload ?? "");
    // Byte-exact key order: iss, role, exp — ref/is_anonymous/iat are omitted
    // entirely (Go's `omitempty`), matching status's no-ref, non-anonymous use.
    expect(raw).toBe('{"iss":"supabase-demo","role":"anon","exp":1983812996}');

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed).toEqual({ iss: "supabase-demo", role: "anon", exp: 1983812996 });
    expect(Object.keys(parsed)).not.toContain("iat");
    expect(Object.keys(parsed)).not.toContain("ref");
    expect(Object.keys(parsed)).not.toContain("is_anonymous");
  });

  it("emits the service_role payload with Go's exact key order and fixed claims", () => {
    const token = legacyGenerateGoJwt(SECRET, "service_role");
    const [, payload] = token.split(".");
    const raw = decodeSegment(payload ?? "");
    expect(raw).toBe('{"iss":"supabase-demo","role":"service_role","exp":1983812996}');
  });

  it("signs with plain HMAC-SHA256 over the base64url header.payload, base64url-encoded", () => {
    const token = legacyGenerateGoJwt(SECRET, "anon");
    const [header, payload, signature] = token.split(".");
    const expectedSignature = createHmac("sha256", SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(signature).toBe(expectedSignature);
  });

  it("is deterministic across calls (no timestamp derived from Date.now())", () => {
    const first = legacyGenerateGoJwt(SECRET, "anon");
    const second = legacyGenerateGoJwt(SECRET, "anon");
    expect(first).toBe(second);
  });

  it("produces different tokens for different secrets", () => {
    const a = legacyGenerateGoJwt(SECRET, "anon");
    const b = legacyGenerateGoJwt("a-different-secret-value-1234567", "anon");
    expect(a).not.toBe(b);
  });
});

describe("legacyGenerateAsymmetricGoJwt", () => {
  it("signs and verifies an RS256 token from an RSA JWK", async () => {
    const jwk = generateRsaJwk("rsa-kid");
    const token = legacyGenerateAsymmetricGoJwt(jwk, "anon");
    const publicKey = await importJWK(publicJwkOf(jwk), "RS256");
    const { payload, protectedHeader } = await jwtVerify(token, publicKey);
    expect(payload).toMatchObject({ iss: "supabase-demo", role: "anon" });
    expect(protectedHeader).toEqual({ alg: "RS256", kid: "rsa-kid", typ: "JWT" });
  });

  it("signs an RS256 token from an RSA JWK missing CRT exponents (dp/dq/qi), matching Go", async () => {
    // Go's `jwkToRSAPrivateKey` (`apps/cli-go/pkg/config/apikeys.go:132-168`)
    // never reads `dp`/`dq`/`qi` — it builds the key from `n`/`e`/`d`/`p`/`q`
    // alone, and Go's stdlib derives the CRT params itself when absent. A
    // hand-authored signing-keys file that omits them (common — RFC 7517 marks
    // them optional) must still sign successfully here.
    const jwk = generateRsaJwk("rsa-kid");
    const { dp: _dp, dq: _dq, qi: _qi, ...jwkWithoutCrtParams } = jwk;
    const token = legacyGenerateAsymmetricGoJwt(jwkWithoutCrtParams, "anon");
    const publicKey = await importJWK(publicJwkOf(jwk), "RS256");
    const { payload, protectedHeader } = await jwtVerify(token, publicKey);
    expect(payload).toMatchObject({ iss: "supabase-demo", role: "anon" });
    expect(protectedHeader).toEqual({ alg: "RS256", kid: "rsa-kid", typ: "JWT" });
  });

  it("signs and verifies an ES256 token from an EC JWK", async () => {
    const jwk = generateEcJwk("ec-kid");
    const token = legacyGenerateAsymmetricGoJwt(jwk, "service_role");
    const publicKey = await importJWK(publicJwkOf(jwk), "ES256");
    const { payload, protectedHeader } = await jwtVerify(token, publicKey);
    expect(payload).toMatchObject({ iss: "supabase-demo", role: "service_role" });
    expect(protectedHeader).toEqual({ alg: "ES256", kid: "ec-kid", typ: "JWT" });
  });

  it("omits the kid header entirely when the JWK has no kid", () => {
    const jwk = generateRsaJwk();
    const token = legacyGenerateAsymmetricGoJwt(jwk, "anon");
    const [header] = token.split(".");
    const decoded = JSON.parse(Buffer.from(header ?? "", "base64url").toString());
    expect(decoded).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("sets a ~10-year expiry computed from the current time, not a fixed timestamp", () => {
    const jwk = generateRsaJwk();
    const before = Math.floor(Date.now() / 1000);
    const token = legacyGenerateAsymmetricGoJwt(jwk, "anon");
    const [, payload] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload ?? "", "base64url").toString());
    const tenYearsSeconds = 60 * 60 * 24 * 365 * 10;
    expect(decoded.exp).toBeGreaterThanOrEqual(before + tenYearsSeconds);
    expect(decoded.exp).toBeLessThan(before + tenYearsSeconds + 10);
  });

  it("rejects an unsupported algorithm", () => {
    const jwk = { ...generateRsaJwk(), alg: "RS512" };
    expect(() => legacyGenerateAsymmetricGoJwt(jwk, "anon")).toThrow(
      "unsupported algorithm: RS512",
    );
  });

  it("rejects a JWK with no algorithm", () => {
    const { alg: _alg, ...jwkWithoutAlg } = generateRsaJwk();
    expect(() => legacyGenerateAsymmetricGoJwt(jwkWithoutAlg, "anon")).toThrow(
      "unsupported algorithm: ",
    );
  });

  // Go has NO explicit kty<->alg cross-check (verified against the real binary,
  // CLI-1961): `jwkToPrivateKey` only validates kty/curve, and the algorithm
  // switch only validates `jwk.Algorithm` — a mismatched pair reaches
  // `token.SignedString(privateKey)` and fails INSIDE golang-jwt's own signing
  // method with "key is of invalid type: ...", wrapped as "failed to sign
  // JWT: %w" (`apikeys.go:113`). These two tests previously asserted an
  // "unsupported key type" message that Go never actually produces for this
  // input — corrected here.
  it("rejects an EC key forged with alg: RS256 instead of signing garbage", () => {
    const jwk = { ...generateEcJwk(), alg: "RS256" };
    expect(() => legacyGenerateAsymmetricGoJwt(jwk, "anon")).toThrow(
      "failed to sign JWT: key is of invalid type: RSA sign expects *rsa.PrivateKey",
    );
  });

  it("rejects an RSA key forged with alg: ES256 instead of signing garbage", () => {
    const jwk = { ...generateRsaJwk(), alg: "ES256" };
    expect(() => legacyGenerateAsymmetricGoJwt(jwk, "anon")).toThrow(
      "failed to sign JWT: key is of invalid type: ECDSA sign expects *ecdsa.PrivateKey",
    );
  });

  it("rejects an ES256 EC key whose curve is not P-256, wrapped like Go's GenerateAsymmetricJWT", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-384" });
    const jwk = { ...privateKey.export({ format: "jwk" }), kty: "EC", alg: "ES256" };
    expect(() => legacyGenerateAsymmetricGoJwt(jwk, "anon")).toThrow(
      "failed to convert JWK to private key: unsupported curve: P-384",
    );
  });

  it("rejects a JWK with no kty at all, wrapped like Go's GenerateAsymmetricJWT", () => {
    // `bearerjwt_test.go`'s "throws error on unsupported kty" fixture uses exactly
    // this shape (`{"kty": "oct"}`, no `alg`) — kty is checked before alg regardless.
    const jwk = { kty: "oct" } as LegacyJwk;
    expect(() => legacyGenerateAsymmetricGoJwt(jwk, "anon")).toThrow(
      "failed to convert JWK to private key: unsupported key type: oct",
    );
  });

  it("rejects an ES256 EC key with no curve at all", () => {
    const jwk = generateEcJwk();
    const { crv: _crv, ...jwkWithoutCurve } = jwk;
    expect(() => legacyGenerateAsymmetricGoJwt(jwkWithoutCurve, "anon")).toThrow(
      "failed to convert JWK to private key: unsupported curve: ",
    );
  });

  it("rejects a padded EC coordinate instead of signing a token Go would refuse to produce (CLI-1961 Codex review finding)", () => {
    // Go's `jwkToECDSAPrivateKey` decodes x/y/d with `base64.RawURLEncoding.DecodeString`,
    // which genuinely rejects `=` padding — verified directly against the real binary:
    // the exact same padded x coordinate produces
    // "failed to convert JWK to private key: failed to decode x coordinate: illegal base64
    // data at input byte 43". Node's own `createPrivateKey({format:"jwk"})` accepts the
    // padding and would otherwise sign successfully, minting a token Go could never produce.
    const jwk = generateEcJwk("ec-kid");
    const padded = { ...jwk, x: `${jwk.x}=` };
    expect(() => legacyGenerateAsymmetricGoJwt(padded, "anon")).toThrow(
      /^failed to convert JWK to private key: failed to decode x coordinate: illegal base64 data at input byte \d+$/,
    );
  });

  it("rejects a padded RSA modulus the same way", () => {
    const jwk = generateRsaJwk("rsa-kid");
    const padded = { ...jwk, n: `${jwk.n}=` };
    expect(() => legacyGenerateAsymmetricGoJwt(padded, "anon")).toThrow(
      /^failed to convert JWK to private key: failed to decode modulus: illegal base64 data at input byte \d+$/,
    );
  });

  it("still signs successfully for unpadded (correctly-encoded) coordinates", () => {
    const jwk = generateEcJwk("ec-kid");
    expect(() => legacyGenerateAsymmetricGoJwt(jwk, "anon")).not.toThrow();
  });
});

describe("legacySignJwtWithJwk", () => {
  it("signs the caller's exact pre-encoded payload string verbatim (no re-serialization)", async () => {
    const jwk = generateEcJwk("ec-kid");
    // Deliberately NOT alphabetically sorted and containing characters Go's
    // `encoding/json` would HTML-escape (`&`) — this function must sign exactly
    // the bytes it's given, leaving ordering/escaping decisions to the caller.
    const payloadJson = '{"role":"postgres","sb-role":"mgmt-api & co"}';
    const token = legacySignJwtWithJwk(jwk, payloadJson);
    const [, payload] = token.split(".");
    expect(decodeSegment(payload ?? "")).toBe(payloadJson);

    const publicKey = await importJWK(publicJwkOf(jwk), "ES256");
    const { payload: verified } = await jwtVerify(token, publicKey);
    expect(verified).toEqual({ role: "postgres", "sb-role": "mgmt-api & co" });
  });

  it("HTML-escapes the kid in the header like Go's json.Marshal, unlike JSON.stringify (CLI-1961 Codex review finding)", () => {
    // Go's `token.SignedString` marshals the protected header via `encoding/json`'s
    // default `json.Marshal`, which HTML-escapes `<`/`>`/`&` — verified directly against
    // the Go standard library. A plain `JSON.stringify` leaves those characters literal,
    // which would sign different header bytes (and thus a different signature) than Go
    // for an otherwise-identical kid.
    const jwk = generateEcJwk("a<b>c&d");
    const token = legacySignJwtWithJwk(jwk, '{"role":"anon"}');
    const [header] = token.split(".");
    expect(decodeSegment(header ?? "")).toBe(
      '{"alg":"ES256","kid":"a\\u003cb\\u003ec\\u0026d","typ":"JWT"}',
    );
  });
});

describe("legacyAssertDecodableJwkAlgorithm", () => {
  it("accepts RS256 and ES256", () => {
    expect(() => legacyAssertDecodableJwkAlgorithm("RS256")).not.toThrow();
    expect(() => legacyAssertDecodableJwkAlgorithm("ES256")).not.toThrow();
  });

  it("accepts an absent alg (validated later, at sign time, not at decode time)", () => {
    expect(() => legacyAssertDecodableJwkAlgorithm(undefined)).not.toThrow();
  });

  it("rejects an unsupported algorithm with Go's exact UnmarshalText message", () => {
    expect(() => legacyAssertDecodableJwkAlgorithm("HS256")).toThrow(
      "must be one of [RS256 ES256]",
    );
  });
});
