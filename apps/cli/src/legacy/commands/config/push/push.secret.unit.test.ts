/**
 * Unit tests for push.secret.ts.
 *
 * The HMAC keys/values below were captured from the same `createHmac` the
 * implementation uses; they lock the exact `hash:<sha256hex>` serialisation.
 */

import { describe, expect, it } from "vitest";

import { legacySecretHash, legacySecretPlaintext } from "./push.secret.ts";

// Shared test vector — same one `legacy-vault-decrypt.unit.test.ts` uses.
// Decrypts to the plaintext "value".
const PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
const ENCRYPTED_VALUE =
  "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";
const WRONG_KEY = "11".repeat(32);

describe("legacySecretHash", () => {
  it("returns the hash:<hmac> form for a plaintext secret", () => {
    expect(legacySecretHash("abcdefghijklmnopqrst", "my-secret", [])).toBe(
      "hash:64800db722cc0be9e1d816d5aed626805e91a939d2dbcbc5239cd31eeef763e9",
    );
    expect(legacySecretHash("test", "topsecret", [])).toBe(
      "hash:8eed2826599c798e072951884ced30954f8322fa1c3648506634e8376a740d72",
    );
  });

  it("keys the HMAC on the project ref (same value, different ref → different hash)", () => {
    expect(legacySecretHash("ref-a", "same", [])).not.toBe(legacySecretHash("ref-b", "same", []));
  });

  it("returns '' for an empty value", () => {
    expect(legacySecretHash("abcdefghijklmnopqrst", "", [])).toBe("");
  });

  it("returns '' for an unresolved env() reference", () => {
    expect(legacySecretHash("abcdefghijklmnopqrst", "env(MY_SECRET)", [])).toBe("");
    expect(legacySecretHash("abcdefghijklmnopqrst", "env()", [])).toBe("");
  });

  it("hashes a value that merely contains (but does not start with) 'encrypted:'", () => {
    // Only the dotenvx prefix is special; an embedded substring is a real secret.
    expect(legacySecretHash("test", "not-encrypted:value", [])).toBe(
      legacySecretHash("test", "not-encrypted:value", []),
    );
    expect(legacySecretHash("test", "not-encrypted:value", []).startsWith("hash:")).toBe(true);
  });

  describe("dotenvx encrypted: values", () => {
    it("decrypts before hashing (hash matches the decrypted plaintext, not the ciphertext)", () => {
      expect(legacySecretHash("abcdefghijklmnopqrst", ENCRYPTED_VALUE, [PRIVATE_KEY])).toBe(
        legacySecretHash("abcdefghijklmnopqrst", "value", []),
      );
    });

    it("tries each key and the first working one wins", () => {
      expect(legacySecretHash("test", ENCRYPTED_VALUE, [WRONG_KEY, PRIVATE_KEY])).toBe(
        legacySecretHash("test", "value", []),
      );
    });

    it("throws 'failed to parse config: missing private key' with no keys", () => {
      expect(() => legacySecretHash("test", ENCRYPTED_VALUE, [])).toThrow(
        "failed to parse config: missing private key",
      );
    });

    it("throws 'failed to parse config: failed to decrypt secret: ...' for a wrong key", () => {
      expect(() => legacySecretHash("test", ENCRYPTED_VALUE, [WRONG_KEY])).toThrow(
        /^failed to parse config: failed to decrypt secret:/,
      );
    });
  });
});

describe("legacySecretPlaintext", () => {
  it("returns a plain value unchanged", () => {
    expect(legacySecretPlaintext("my-secret", [])).toBe("my-secret");
    expect(legacySecretPlaintext("", [])).toBe("");
  });

  it("decrypts a dotenvx encrypted: value to its plaintext", () => {
    expect(legacySecretPlaintext(ENCRYPTED_VALUE, [PRIVATE_KEY])).toBe("value");
  });

  it("never returns the ciphertext when decryption fails — throws instead", () => {
    expect(() => legacySecretPlaintext(ENCRYPTED_VALUE, [])).toThrow(
      "failed to parse config: missing private key",
    );
  });
});
