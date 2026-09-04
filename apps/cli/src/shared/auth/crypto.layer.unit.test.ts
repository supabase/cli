import { Buffer } from "node:buffer";
import { describe, expect, it } from "@effect/vitest";
import { createCipheriv, createECDH, randomBytes } from "node:crypto";
import { vi } from "vitest";
import { Cause, Effect, Exit } from "effect";
import { Crypto } from "./crypto.service.ts";
import { cryptoLayer } from "./crypto.layer.ts";

const mockOs = vi.hoisted(() => ({
  userInfoShouldThrow: false,
  userInfoReturnEmptyUsername: false,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    userInfo: (...args: Parameters<typeof actual.userInfo>) => {
      if (mockOs.userInfoShouldThrow) throw new Error("userInfo unavailable");
      if (mockOs.userInfoReturnEmptyUsername) return { ...actual.userInfo(...args), username: "" };
      return actual.userInfo(...args);
    },
  };
});

const testLayer = cryptoLayer;

/**
 * Encrypts a plaintext string using AES-256-GCM with an ECDH shared secret.
 * This is the inverse of `decryptToken` in the Crypto service and is used
 * to set up meaningful round-trip tests.
 */
function encryptWithEcdh(
  serverPrivateKeyHex: string,
  clientPublicKeyHex: string,
  plaintext: string,
): { ciphertext: string; publicKey: string; nonce: string } {
  const serverEcdh = createECDH("prime256v1");
  serverEcdh.setPrivateKey(Buffer.from(serverPrivateKeyHex, "hex"));
  const sharedSecret = serverEcdh.computeSecret(Buffer.from(clientPublicKeyHex, "hex"));

  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sharedSecret, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // ciphertext = encrypted || authTag (16 bytes = 32 hex chars)
  const ciphertext = encrypted.toString("hex") + authTag.toString("hex");

  return {
    ciphertext,
    publicKey: serverEcdh.getPublicKey("hex", "uncompressed"),
    nonce: nonce.toString("hex"),
  };
}

describe("Crypto", () => {
  describe("generateKeyPair", () => {
    it.effect("returns an ECDH instance and a hex-encoded uncompressed public key", () => {
      return Effect.gen(function* () {
        const { generateKeyPair } = yield* Crypto;
        const { ecdh, publicKeyHex } = yield* generateKeyPair;

        // Uncompressed EC public keys on prime256v1 are 65 bytes = 130 hex chars,
        // and always start with the 0x04 prefix byte.
        expect(publicKeyHex).toHaveLength(130);
        expect(publicKeyHex.startsWith("04")).toBe(true);

        // The ECDH object must have a private key so we can compute shared secrets.
        expect(ecdh.getPrivateKey()).toBeInstanceOf(Buffer);
        expect(ecdh.getPrivateKey().length).toBeGreaterThan(0);

        // The public key reported by the object must match the returned hex string.
        expect(ecdh.getPublicKey("hex", "uncompressed")).toBe(publicKeyHex);
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("generates a different key pair on each call", () => {
      return Effect.gen(function* () {
        const { generateKeyPair } = yield* Crypto;
        const first = yield* generateKeyPair;
        const second = yield* generateKeyPair;
        expect(first.publicKeyHex).not.toBe(second.publicKeyHex);
      }).pipe(Effect.provide(testLayer));
    });
  });

  describe("generateSessionId", () => {
    it.effect("returns a valid UUID v4", () => {
      return Effect.gen(function* () {
        const { generateSessionId } = yield* Crypto;
        const id = yield* generateSessionId;
        expect(id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("generates a different session ID on each call", () => {
      return Effect.gen(function* () {
        const { generateSessionId } = yield* Crypto;
        const first = yield* generateSessionId;
        const second = yield* generateSessionId;
        expect(first).not.toBe(second);
      }).pipe(Effect.provide(testLayer));
    });
  });

  describe("defaultTokenName", () => {
    it.effect("returns a string starting with cli_", () => {
      return Effect.gen(function* () {
        const { defaultTokenName } = yield* Crypto;
        const name = yield* defaultTokenName;
        expect(name.startsWith("cli_")).toBe(true);
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("contains a numeric timestamp", () => {
      const before = Date.now();
      return Effect.gen(function* () {
        const { defaultTokenName } = yield* Crypto;
        const name = yield* defaultTokenName;
        const after = Date.now();

        // Extract the trailing numeric timestamp from the token name.
        // Both formats end with _<timestamp>: cli_<ts> or cli_<user>@<host>_<ts>
        const match = name.match(/_(\d+)$/);
        expect(match).not.toBeNull();
        const ts = Number(match![1]);
        expect(ts).toBeGreaterThanOrEqual(before);
        expect(ts).toBeLessThanOrEqual(after);
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("falls back to cli_<ts> when userInfo throws", () => {
      mockOs.userInfoShouldThrow = true;
      // The Crypto layer is a sync layer, so we need to build a fresh one
      // after the mock is set up; re-use testLayer since defaultTokenName
      // calls userInfo lazily at invocation time (inside Effect.sync).
      return Effect.gen(function* () {
        const { defaultTokenName } = yield* Crypto;
        const name = yield* defaultTokenName;
        // The fallback format is exactly cli_<timestamp> with no @ or host part
        expect(name).toMatch(/^cli_\d+$/);
      })
        .pipe(Effect.provide(testLayer))
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              mockOs.userInfoShouldThrow = false;
            }),
          ),
        );
    });

    it.effect("falls back to cli_<ts> when username is empty (if-branch false path)", () => {
      mockOs.userInfoReturnEmptyUsername = true;
      return Effect.gen(function* () {
        const { defaultTokenName } = yield* Crypto;
        const name = yield* defaultTokenName;
        // Empty username makes the if-condition falsy, producing the bare timestamp format
        expect(name).toMatch(/^cli_\d+$/);
      })
        .pipe(Effect.provide(testLayer))
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              mockOs.userInfoReturnEmptyUsername = false;
            }),
          ),
        );
    });
  });

  describe("decryptToken", () => {
    it.effect("decrypts a token encrypted with the corresponding ECDH public key", () => {
      return Effect.gen(function* () {
        const { generateKeyPair, decryptToken } = yield* Crypto;

        // Client (CLI) side: generate key pair
        const { ecdh: clientEcdh, publicKeyHex: clientPublicKeyHex } = yield* generateKeyPair;

        // Server side: encrypt a known plaintext directed at the client's public key
        const serverEcdh = createECDH("prime256v1");
        serverEcdh.generateKeys();
        const serverPrivateKeyHex = serverEcdh.getPrivateKey("hex");
        const plaintext = "sbp_test_secret_access_token_12345";
        const payload = encryptWithEcdh(serverPrivateKeyHex, clientPublicKeyHex, plaintext);

        // Client (CLI) side: decrypt using the private key
        const decrypted = yield* decryptToken(clientEcdh, payload);
        expect(decrypted).toBe(plaintext);
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("decrypts tokens containing unicode characters", () => {
      return Effect.gen(function* () {
        const { generateKeyPair, decryptToken } = yield* Crypto;

        const { ecdh: clientEcdh, publicKeyHex: clientPublicKeyHex } = yield* generateKeyPair;

        const serverEcdh = createECDH("prime256v1");
        serverEcdh.generateKeys();
        const serverPrivateKeyHex = serverEcdh.getPrivateKey("hex");
        const plaintext = "token_with_unicode_\u00e9\u4e2d\u6587";
        const payload = encryptWithEcdh(serverPrivateKeyHex, clientPublicKeyHex, plaintext);

        const decrypted = yield* decryptToken(clientEcdh, payload);
        expect(decrypted).toBe(plaintext);
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("produces different ciphertexts for the same plaintext due to random nonce", () => {
      return Effect.gen(function* () {
        const { generateKeyPair, decryptToken } = yield* Crypto;

        const { ecdh: clientEcdh, publicKeyHex: clientPublicKeyHex } = yield* generateKeyPair;

        const serverEcdh = createECDH("prime256v1");
        serverEcdh.generateKeys();
        const serverPrivateKeyHex = serverEcdh.getPrivateKey("hex");
        const plaintext = "same_plaintext";

        const payload1 = encryptWithEcdh(serverPrivateKeyHex, clientPublicKeyHex, plaintext);
        const payload2 = encryptWithEcdh(serverPrivateKeyHex, clientPublicKeyHex, plaintext);

        // Different nonces → different ciphertexts
        expect(payload1.nonce).not.toBe(payload2.nonce);
        expect(payload1.ciphertext).not.toBe(payload2.ciphertext);

        // Both ciphertexts must still decrypt to the same original plaintext
        const decrypted1 = yield* decryptToken(clientEcdh, payload1);
        const decrypted2 = yield* decryptToken(clientEcdh, payload2);
        expect(decrypted1).toBe(plaintext);
        expect(decrypted2).toBe(plaintext);
      }).pipe(Effect.provide(testLayer));
    });

    it.effect("fails when the ciphertext has been tampered with", () => {
      return Effect.gen(function* () {
        const { generateKeyPair, decryptToken } = yield* Crypto;

        const { ecdh: clientEcdh, publicKeyHex: clientPublicKeyHex } = yield* generateKeyPair;

        const serverEcdh = createECDH("prime256v1");
        serverEcdh.generateKeys();
        const serverPrivateKeyHex = serverEcdh.getPrivateKey("hex");
        const plaintext = "sbp_secret_token_to_tamper";

        const payload = encryptWithEcdh(serverPrivateKeyHex, clientPublicKeyHex, plaintext);

        // Flip the first character of the ciphertext to corrupt the auth tag verification
        const firstChar = payload.ciphertext[0];
        const flippedChar = firstChar === "a" ? "b" : "a";
        const tamperedPayload = {
          ...payload,
          ciphertext: flippedChar + payload.ciphertext.slice(1),
        };

        // AES-GCM auth tag verification should cause a Die (defect) since decryptToken
        // uses Effect.sync and the underlying crypto call throws on tampered ciphertext
        const exit = yield* decryptToken(clientEcdh, tamperedPayload).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const hasDie = exit.cause.reasons.some(Cause.isDieReason);
          expect(hasDie).toBe(true);
        }
      }).pipe(Effect.provide(testLayer));
    });
  });
});
