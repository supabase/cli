import { createHmac, generateKeyPairSync } from "node:crypto";
import { importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";

import {
  assertDecodableJwkAlgorithm,
  generateAsymmetricLocalJwt,
  generateLocalJwt,
  signJwtWithJwk,
  type Jwk,
} from "./local-jwt.ts";

const SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";

function generateRsaJwk(kid?: string): Jwk {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" });
  return { ...jwk, kty: "RSA", alg: "RS256", kid };
}

function generateEcJwk(kid?: string): Jwk {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  return { ...jwk, kty: "EC", alg: "ES256", kid };
}

function publicJwkOf(jwk: Jwk): Jwk {
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...publicJwk } = jwk;
  return publicJwk;
}

function decodeSegment(segment: string): string {
  return Buffer.from(segment, "base64url").toString("utf8");
}

describe("generateLocalJwt", () => {
  it("emits the JWT header (no extra fields, alg before typ)", () => {
    const token = generateLocalJwt(SECRET, "anon");
    const [header] = token.split(".");
    expect(header).toBeDefined();
    expect(decodeSegment(header ?? "")).toBe('{"alg":"HS256","typ":"JWT"}');
  });

  it("emits the anon payload with the exact key order and fixed claims", () => {
    const token = generateLocalJwt(SECRET, "anon");
    const [, payload] = token.split(".");
    expect(payload).toBeDefined();
    const raw = decodeSegment(payload ?? "");
    expect(raw).toBe('{"iss":"supabase-demo","role":"anon","exp":1983812996}');

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed).toEqual({ iss: "supabase-demo", role: "anon", exp: 1983812996 });
    expect(Object.keys(parsed)).not.toContain("iat");
    expect(Object.keys(parsed)).not.toContain("ref");
    expect(Object.keys(parsed)).not.toContain("is_anonymous");
  });

  it("emits the service_role payload with the exact key order and fixed claims", () => {
    const token = generateLocalJwt(SECRET, "service_role");
    const [, payload] = token.split(".");
    const raw = decodeSegment(payload ?? "");
    expect(raw).toBe('{"iss":"supabase-demo","role":"service_role","exp":1983812996}');
  });

  it("signs with plain HMAC-SHA256 over the base64url header.payload, base64url-encoded", () => {
    const token = generateLocalJwt(SECRET, "anon");
    const [header, payload, signature] = token.split(".");
    const expectedSignature = createHmac("sha256", SECRET)
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(signature).toBe(expectedSignature);
  });

  it("is deterministic across calls (no timestamp derived from Date.now())", () => {
    const first = generateLocalJwt(SECRET, "anon");
    const second = generateLocalJwt(SECRET, "anon");
    expect(first).toBe(second);
  });

  it("produces different tokens for different secrets", () => {
    const a = generateLocalJwt(SECRET, "anon");
    const b = generateLocalJwt("a-different-secret-value-1234567", "anon");
    expect(a).not.toBe(b);
  });
});

describe("generateAsymmetricLocalJwt", () => {
  it("signs and verifies an RS256 token from an RSA JWK", async () => {
    const jwk = generateRsaJwk("rsa-kid");
    const token = generateAsymmetricLocalJwt(jwk, "anon");
    const publicKey = await importJWK(publicJwkOf(jwk), "RS256");
    const { payload, protectedHeader } = await jwtVerify(token, publicKey);
    expect(payload).toMatchObject({ iss: "supabase-demo", role: "anon" });
    expect(protectedHeader).toEqual({ alg: "RS256", kid: "rsa-kid", typ: "JWT" });
  });

  it("signs an RS256 token from an RSA JWK missing CRT exponents (dp/dq/qi)", async () => {
    const jwk = generateRsaJwk("rsa-kid");
    const { dp: _dp, dq: _dq, qi: _qi, ...jwkWithoutCrtParams } = jwk;
    const token = generateAsymmetricLocalJwt(jwkWithoutCrtParams, "anon");
    const publicKey = await importJWK(publicJwkOf(jwk), "RS256");
    const { payload, protectedHeader } = await jwtVerify(token, publicKey);
    expect(payload).toMatchObject({ iss: "supabase-demo", role: "anon" });
    expect(protectedHeader).toEqual({ alg: "RS256", kid: "rsa-kid", typ: "JWT" });
  });

  it("signs and verifies an ES256 token from an EC JWK", async () => {
    const jwk = generateEcJwk("ec-kid");
    const token = generateAsymmetricLocalJwt(jwk, "service_role");
    const publicKey = await importJWK(publicJwkOf(jwk), "ES256");
    const { payload, protectedHeader } = await jwtVerify(token, publicKey);
    expect(payload).toMatchObject({ iss: "supabase-demo", role: "service_role" });
    expect(protectedHeader).toEqual({ alg: "ES256", kid: "ec-kid", typ: "JWT" });
  });

  it("omits the kid header entirely when the JWK has no kid", () => {
    const jwk = generateRsaJwk();
    const token = generateAsymmetricLocalJwt(jwk, "anon");
    const [header] = token.split(".");
    const decoded = JSON.parse(Buffer.from(header ?? "", "base64url").toString());
    expect(decoded).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("sets a ~10-year expiry computed from the current time, not a fixed timestamp", () => {
    const jwk = generateRsaJwk();
    const before = Math.floor(Date.now() / 1000);
    const token = generateAsymmetricLocalJwt(jwk, "anon");
    const [, payload] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload ?? "", "base64url").toString());
    const tenYearsSeconds = 60 * 60 * 24 * 365 * 10;
    expect(decoded.exp).toBeGreaterThanOrEqual(before + tenYearsSeconds);
    expect(decoded.exp).toBeLessThan(before + tenYearsSeconds + 10);
  });

  it("rejects an unsupported algorithm", () => {
    const jwk = { ...generateRsaJwk(), alg: "RS512" };
    expect(() => generateAsymmetricLocalJwt(jwk, "anon")).toThrow("unsupported algorithm: RS512");
  });

  it("rejects a JWK with no algorithm", () => {
    const { alg: _alg, ...jwkWithoutAlg } = generateRsaJwk();
    expect(() => generateAsymmetricLocalJwt(jwkWithoutAlg, "anon")).toThrow(
      "unsupported algorithm: ",
    );
  });

  it("rejects an EC key forged with alg: RS256 instead of signing garbage", () => {
    const jwk = { ...generateEcJwk(), alg: "RS256" };
    expect(() => generateAsymmetricLocalJwt(jwk, "anon")).toThrow(
      "failed to sign JWT: key is of invalid type: RSA sign expects *rsa.PrivateKey",
    );
  });

  it("rejects an RSA key forged with alg: ES256 instead of signing garbage", () => {
    const jwk = { ...generateRsaJwk(), alg: "ES256" };
    expect(() => generateAsymmetricLocalJwt(jwk, "anon")).toThrow(
      "failed to sign JWT: key is of invalid type: ECDSA sign expects *ecdsa.PrivateKey",
    );
  });

  it("rejects an ES256 EC key whose curve is not P-256, wrapped in the private-key conversion error", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-384" });
    const jwk = { ...privateKey.export({ format: "jwk" }), kty: "EC", alg: "ES256" };
    expect(() => generateAsymmetricLocalJwt(jwk, "anon")).toThrow(
      "failed to convert JWK to private key: unsupported curve: P-384",
    );
  });

  it("rejects a JWK with no kty at all, wrapped in the private-key conversion error", () => {
    const jwk = { kty: "oct" } as Jwk;
    expect(() => generateAsymmetricLocalJwt(jwk, "anon")).toThrow(
      "failed to convert JWK to private key: unsupported key type: oct",
    );
  });

  it("rejects an ES256 EC key with no curve at all", () => {
    const jwk = generateEcJwk();
    const { crv: _crv, ...jwkWithoutCurve } = jwk;
    expect(() => generateAsymmetricLocalJwt(jwkWithoutCurve, "anon")).toThrow(
      "failed to convert JWK to private key: unsupported curve: ",
    );
  });

  it("rejects a padded EC coordinate instead of signing an invalid token", () => {
    const jwk = generateEcJwk("ec-kid");
    const padded = { ...jwk, x: `${jwk.x}=` };
    expect(() => generateAsymmetricLocalJwt(padded, "anon")).toThrow(
      /^failed to convert JWK to private key: failed to decode x coordinate: illegal base64 data at input byte \d+$/,
    );
  });

  it("rejects a padded RSA modulus the same way", () => {
    const jwk = generateRsaJwk("rsa-kid");
    const padded = { ...jwk, n: `${jwk.n}=` };
    expect(() => generateAsymmetricLocalJwt(padded, "anon")).toThrow(
      /^failed to convert JWK to private key: failed to decode modulus: illegal base64 data at input byte \d+$/,
    );
  });

  it("still signs successfully for unpadded (correctly-encoded) coordinates", () => {
    const jwk = generateEcJwk("ec-kid");
    expect(() => generateAsymmetricLocalJwt(jwk, "anon")).not.toThrow();
  });
});

describe("signJwtWithJwk", () => {
  it("signs the caller's exact pre-encoded payload string verbatim (no re-serialization)", async () => {
    const jwk = generateEcJwk("ec-kid");
    // Unsorted and containing `&`, which the encoder would normally HTML-escape: this function
    // must sign exactly the bytes it's given.
    const payloadJson = '{"role":"postgres","sb-role":"mgmt-api & co"}';
    const token = signJwtWithJwk(jwk, payloadJson);
    const [, payload] = token.split(".");
    expect(decodeSegment(payload ?? "")).toBe(payloadJson);

    const publicKey = await importJWK(publicJwkOf(jwk), "ES256");
    const { payload: verified } = await jwtVerify(token, publicKey);
    expect(verified).toEqual({ role: "postgres", "sb-role": "mgmt-api & co" });
  });

  it("HTML-escapes the kid in the header, unlike JSON.stringify", () => {
    const jwk = generateEcJwk("a<b>c&d");
    const token = signJwtWithJwk(jwk, '{"role":"anon"}');
    const [header] = token.split(".");
    expect(decodeSegment(header ?? "")).toBe(
      '{"alg":"ES256","kid":"a\\u003cb\\u003ec\\u0026d","typ":"JWT"}',
    );
  });
});

describe("assertDecodableJwkAlgorithm", () => {
  it("accepts RS256 and ES256", () => {
    expect(() => assertDecodableJwkAlgorithm("RS256")).not.toThrow();
    expect(() => assertDecodableJwkAlgorithm("ES256")).not.toThrow();
  });

  it("accepts an absent alg (validated later, at sign time, not at decode time)", () => {
    expect(() => assertDecodableJwkAlgorithm(undefined)).not.toThrow();
  });

  it("rejects an unsupported algorithm with the allowed-values message", () => {
    expect(() => assertDecodableJwkAlgorithm("HS256")).toThrow("must be one of [RS256 ES256]");
  });
});
