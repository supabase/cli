import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defaultPublishableKey, defaultSecretKey } from "./JwtGenerator.ts";
import { resolveLocalCredentials } from "./LocalCredentials.ts";

const localEs256Key = {
  kty: "EC",
  kid: "local-auth-test",
  use: "sig",
  alg: "ES256",
  crv: "P-256",
  x: "M5Sjqn5zwC9Kl1zVfUUGvv9boQjCGd45G8sdopBExB4",
  y: "P6IXMvA2WYXSHSOMTBH2jsw_9rrzGy89FjPf6oOsIxQ",
  d: "dIhR8wywJlqlua4y_yMq2SLhlFXDZJBCvFrY1DCHyVU",
};

describe("resolveLocalCredentials", () => {
  it("resolves symmetric defaults as one coherent credential set", () => {
    const credentials = resolveLocalCredentials(undefined);

    expect(credentials.signing._tag).toBe("SymmetricJwtSecret");
    expect(credentials.publishableKey).toBe(defaultPublishableKey);
    expect(credentials.secretKey).toBe(defaultSecretKey);
    expect(credentials.anonKey.split(".")).toHaveLength(3);
    expect(credentials.serviceRoleKey.split(".")).toHaveLength(3);
    expect(JSON.parse(credentials.jwks)).toEqual({
      keys: [expect.objectContaining({ kty: "oct", k: expect.any(String) })],
    });
  });

  it("signs role tokens with the first asymmetric key and publishes only public material", () => {
    const credentials = resolveLocalCredentials({
      signing: {
        _tag: "AsymmetricJwtKeys",
        legacySecret: "legacy-shared-secret-with-at-least-32-characters",
        keys: [localEs256Key],
      },
    });
    const [headerEncoded, payloadEncoded, signatureEncoded] = credentials.anonKey.split(".");
    expect(headerEncoded).toBeDefined();
    expect(payloadEncoded).toBeDefined();
    expect(signatureEncoded).toBeDefined();
    if (
      headerEncoded === undefined ||
      payloadEncoded === undefined ||
      signatureEncoded === undefined
    ) {
      return;
    }

    expect(JSON.parse(Buffer.from(headerEncoded, "base64url").toString("utf8"))).toMatchObject({
      alg: "ES256",
      kid: "local-auth-test",
    });
    expect(JSON.parse(Buffer.from(payloadEncoded, "base64url").toString("utf8"))).toMatchObject({
      role: "anon",
    });
    const publicKey = createPublicKey({ key: localEs256Key, format: "jwk" });
    expect(
      verify(
        "sha256",
        Buffer.from(`${headerEncoded}.${payloadEncoded}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signatureEncoded, "base64url"),
      ),
    ).toBe(true);

    const publicJwks = JSON.parse(credentials.jwks);
    expect(publicJwks.keys[0]).not.toHaveProperty("d");
    expect(publicJwks.keys[0]).not.toHaveProperty("p");
    expect(publicJwks.keys[0]).not.toHaveProperty("q");
  });

  it("rejects mismatched private keys with path-only typed errors", () => {
    expect.assertions(4);
    try {
      resolveLocalCredentials({
        signing: {
          _tag: "AsymmetricJwtKeys",
          legacySecret: "legacy-shared-secret-with-at-least-32-characters",
          keys: [{ ...localEs256Key, kty: "RSA", d: "do-not-expose-private-key" }],
        },
      });
    } catch (error) {
      expect(error).toMatchObject({
        _tag: "LocalCredentialsError",
        path: "credentials.signing.keys[0]",
      });
      expect(JSON.stringify(error)).not.toContain("do-not-expose-private-key");
      expect(JSON.stringify(error)).not.toContain(localEs256Key.x);
      expect(JSON.stringify(error)).not.toContain(localEs256Key.y);
    }
  });

  it("validates public components on every later verification key", () => {
    expect.assertions(1);
    try {
      resolveLocalCredentials({
        signing: {
          _tag: "AsymmetricJwtKeys",
          legacySecret: "legacy-shared-secret-with-at-least-32-characters",
          keys: [localEs256Key, { ...localEs256Key, kid: "invalid-verifier", x: undefined }],
        },
      });
    } catch (error) {
      expect(error).toMatchObject({
        _tag: "LocalCredentialsError",
        path: "credentials.signing.keys[1]",
      });
    }
  });

  it("honors configured opaque and legacy role keys without recomputing them", () => {
    const credentials = resolveLocalCredentials({
      publishableKey: "sb_publishable_override",
      secretKey: "sb_secret_override",
      anonKey: "anon-override",
      serviceRoleKey: "service-role-override",
    });

    expect(credentials).toMatchObject({
      publishableKey: "sb_publishable_override",
      secretKey: "sb_secret_override",
      anonKey: "anon-override",
      serviceRoleKey: "service-role-override",
    });
  });

  it("rejects short shared secrets without retaining their value", () => {
    expect.assertions(2);
    try {
      resolveLocalCredentials({
        signing: { _tag: "SymmetricJwtSecret", secret: "short-secret-value" },
      });
    } catch (error) {
      expect(error).toMatchObject({
        _tag: "LocalCredentialsError",
        path: "credentials.signing.secret",
      });
      expect(JSON.stringify(error)).not.toContain("short-secret-value");
    }
  });
});
