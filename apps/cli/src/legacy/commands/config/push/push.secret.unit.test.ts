/**
 * Unit tests for push.secret.ts.
 *
 * The HMAC keys/values below were captured from the same `createHmac` the
 * implementation uses; they lock the exact bare-hex digest.
 */

import { describe, expect, it } from "vitest";

import { legacySecretDigestHex, legacySecretPlaintext } from "./push.secret.ts";

// Shared test vector — same one `legacy-vault-decrypt.unit.test.ts` uses.
// Decrypts to the plaintext "value".
const PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
const ENCRYPTED_VALUE =
  "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";
const WRONG_KEY = "11".repeat(32);

describe("legacySecretDigestHex", () => {
  it("returns the bare hmac hex for a plaintext secret", () => {
    expect(legacySecretDigestHex("abcdefghijklmnopqrst", "my-secret", [])).toBe(
      "64800db722cc0be9e1d816d5aed626805e91a939d2dbcbc5239cd31eeef763e9",
    );
    expect(legacySecretDigestHex("test", "topsecret", [])).toBe(
      "8eed2826599c798e072951884ced30954f8322fa1c3648506634e8376a740d72",
    );
  });

  it("keys the HMAC on the project ref (same value, different ref → different hash)", () => {
    expect(legacySecretDigestHex("ref-a", "same", [])).not.toBe(
      legacySecretDigestHex("ref-b", "same", []),
    );
  });

  it("returns undefined for an empty value", () => {
    expect(legacySecretDigestHex("abcdefghijklmnopqrst", "", [])).toBeUndefined();
  });

  it("returns undefined for an unresolved env() reference", () => {
    expect(legacySecretDigestHex("abcdefghijklmnopqrst", "env(MY_SECRET)", [])).toBeUndefined();
    expect(legacySecretDigestHex("abcdefghijklmnopqrst", "env()", [])).toBeUndefined();
  });

  it("hashes a value that merely contains (but does not start with) 'encrypted:'", () => {
    // Only the dotenvx prefix is special; an embedded substring is a real secret.
    expect(legacySecretDigestHex("test", "not-encrypted:value", [])).toBe(
      legacySecretDigestHex("test", "not-encrypted:value", []),
    );
    expect(legacySecretDigestHex("test", "not-encrypted:value", [])).toMatch(/^[0-9a-f]+$/);
  });

  describe("dotenvx encrypted: values", () => {
    it("decrypts before hashing (hash matches the decrypted plaintext, not the ciphertext)", () => {
      expect(legacySecretDigestHex("abcdefghijklmnopqrst", ENCRYPTED_VALUE, [PRIVATE_KEY])).toBe(
        legacySecretDigestHex("abcdefghijklmnopqrst", "value", []),
      );
    });

    it("tries each key and the first working one wins", () => {
      expect(legacySecretDigestHex("test", ENCRYPTED_VALUE, [WRONG_KEY, PRIVATE_KEY])).toBe(
        legacySecretDigestHex("test", "value", []),
      );
    });

    it("throws 'failed to parse config: missing private key' with no keys", () => {
      expect(() => legacySecretDigestHex("test", ENCRYPTED_VALUE, [])).toThrow(
        "failed to parse config: missing private key",
      );
    });

    it("throws 'failed to parse config: failed to decrypt secret: ...' for a wrong key", () => {
      expect(() => legacySecretDigestHex("test", ENCRYPTED_VALUE, [WRONG_KEY])).toThrow(
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
