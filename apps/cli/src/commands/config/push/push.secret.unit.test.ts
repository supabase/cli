import { describe, expect, it } from "vitest";

import { secretDigestHex, secretPlaintext } from "./push.secret.ts";

// The HMAC keys/values below were captured from the same `createHmac` the implementation uses;
// they lock the exact bare-hex digest.

// Shared test vector (also used by `vault-decrypt.unit.test.ts`); decrypts to "value".
const PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
const ENCRYPTED_VALUE =
  "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";
const WRONG_KEY = "11".repeat(32);

describe("secretDigestHex", () => {
  it("returns the bare hmac hex for a plaintext secret", () => {
    expect(secretDigestHex("abcdefghijklmnopqrst", "my-secret", [])).toBe(
      "64800db722cc0be9e1d816d5aed626805e91a939d2dbcbc5239cd31eeef763e9",
    );
    expect(secretDigestHex("test", "topsecret", [])).toBe(
      "8eed2826599c798e072951884ced30954f8322fa1c3648506634e8376a740d72",
    );
  });

  it("keys the HMAC on the project ref (same value, different ref → different hash)", () => {
    expect(secretDigestHex("ref-a", "same", [])).not.toBe(secretDigestHex("ref-b", "same", []));
  });

  it("returns undefined for an empty value", () => {
    expect(secretDigestHex("abcdefghijklmnopqrst", "", [])).toBeUndefined();
  });

  it("returns undefined for an unresolved env() reference", () => {
    expect(secretDigestHex("abcdefghijklmnopqrst", "env(MY_SECRET)", [])).toBeUndefined();
    expect(secretDigestHex("abcdefghijklmnopqrst", "env()", [])).toBeUndefined();
  });

  it("hashes a value that merely contains (but does not start with) 'encrypted:'", () => {
    expect(secretDigestHex("test", "not-encrypted:value", [])).toBe(
      secretDigestHex("test", "not-encrypted:value", []),
    );
    expect(secretDigestHex("test", "not-encrypted:value", [])).toMatch(/^[0-9a-f]+$/);
  });

  describe("dotenvx encrypted: values", () => {
    it("decrypts before hashing (hash matches the decrypted plaintext, not the ciphertext)", () => {
      expect(secretDigestHex("abcdefghijklmnopqrst", ENCRYPTED_VALUE, [PRIVATE_KEY])).toBe(
        secretDigestHex("abcdefghijklmnopqrst", "value", []),
      );
    });

    it("tries each key and the first working one wins", () => {
      expect(secretDigestHex("test", ENCRYPTED_VALUE, [WRONG_KEY, PRIVATE_KEY])).toBe(
        secretDigestHex("test", "value", []),
      );
    });

    it("throws 'failed to parse config: missing private key' with no keys", () => {
      expect(() => secretDigestHex("test", ENCRYPTED_VALUE, [])).toThrow(
        "failed to parse config: missing private key",
      );
    });

    it("throws 'failed to parse config: failed to decrypt secret: ...' for a wrong key", () => {
      expect(() => secretDigestHex("test", ENCRYPTED_VALUE, [WRONG_KEY])).toThrow(
        /^failed to parse config: failed to decrypt secret:/,
      );
    });
  });
});

describe("secretPlaintext", () => {
  it("returns a plain value unchanged", () => {
    expect(secretPlaintext("my-secret", [])).toBe("my-secret");
    expect(secretPlaintext("", [])).toBe("");
  });

  it("decrypts a dotenvx encrypted: value to its plaintext", () => {
    expect(secretPlaintext(ENCRYPTED_VALUE, [PRIVATE_KEY])).toBe("value");
  });

  it("never returns the ciphertext when decryption fails — throws instead", () => {
    expect(() => secretPlaintext(ENCRYPTED_VALUE, [])).toThrow(
      "failed to parse config: missing private key",
    );
  });
});
