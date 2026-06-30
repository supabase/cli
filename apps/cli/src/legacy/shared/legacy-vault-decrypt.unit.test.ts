import { describe, expect, it } from "vitest";

import {
  legacyCollectDotenvPrivateKeys,
  legacyDecryptSecret,
  legacyIsEncryptedSecret,
} from "./legacy-vault-decrypt.ts";

// Go's test vector — `apps/cli-go/pkg/config/secret_test.go:9-19`. The same
// keypair/ciphertext must decrypt identically here, proving `eciesjs`
// cross-decrypts `github.com/ecies/go/v2`'s output.
const PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
const ENCRYPTED_VALUE =
  "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";
const WRONG_KEY = "11".repeat(32);

describe("legacyIsEncryptedSecret", () => {
  it("matches only the leading encrypted: prefix", () => {
    expect(legacyIsEncryptedSecret(ENCRYPTED_VALUE)).toBe(true);
    expect(legacyIsEncryptedSecret("encrypted:anything")).toBe(true);
    // Must START with the prefix — a value that merely contains it is not encrypted.
    expect(legacyIsEncryptedSecret("not-encrypted:value")).toBe(false);
    expect(legacyIsEncryptedSecret("plain")).toBe(false);
  });
});

describe("legacyDecryptSecret", () => {
  it("decrypts Go's test vector to the expected plaintext", () => {
    const result = legacyDecryptSecret(ENCRYPTED_VALUE, [PRIVATE_KEY]);
    expect(result).toEqual({ ok: true, value: "value" });
  });

  it("tries each key and the first working one wins", () => {
    const result = legacyDecryptSecret(ENCRYPTED_VALUE, [WRONG_KEY, PRIVATE_KEY]);
    expect(result).toEqual({ ok: true, value: "value" });
  });

  it("fails with 'missing private key' when no keys are available", () => {
    expect(legacyDecryptSecret(ENCRYPTED_VALUE, [])).toEqual({
      ok: false,
      error: "missing private key",
    });
  });

  it("fails with a hex-decode error for a non-hex key", () => {
    const result = legacyDecryptSecret(ENCRYPTED_VALUE, ["nothex"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("failed to hex decode private key:");
  });

  it("fails with a decrypt error for a valid but wrong key", () => {
    const result = legacyDecryptSecret(ENCRYPTED_VALUE, [WRONG_KEY]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("failed to decrypt secret:");
  });

  it("fails with a base64 error for malformed ciphertext", () => {
    const result = legacyDecryptSecret("encrypted:not valid base64!", [PRIVATE_KEY]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("failed to base64 decode secret:");
  });

  it("returns the last key's error when every key fails", () => {
    // Wrong-but-valid key decrypt-fails, then the non-hex key hex-fails last.
    const result = legacyDecryptSecret(ENCRYPTED_VALUE, [WRONG_KEY, "nothex"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("failed to hex decode private key:");
  });
});

describe("legacyCollectDotenvPrivateKeys", () => {
  it("collects DOTENV_PRIVATE_KEY and DOTENV_PRIVATE_KEY_* values, comma-split", () => {
    const keys = legacyCollectDotenvPrivateKeys({
      DOTENV_PRIVATE_KEY: "aa,bb",
      DOTENV_PRIVATE_KEY_PRODUCTION: "cc",
      DOTENV_PUBLIC_KEY: "ignored",
      PATH: "/usr/bin",
      EMPTY: undefined,
    });
    expect(keys).toEqual(["aa", "bb", "cc"]);
  });

  it("requires the underscore for the prefixed form and drops empty entries", () => {
    const keys = legacyCollectDotenvPrivateKeys({
      // No underscore after the prefix → not a private-key var (Go requires `_`).
      DOTENV_PRIVATE_KEYX: "nope",
      DOTENV_PRIVATE_KEY: ",,",
    });
    expect(keys).toEqual([]);
  });
});
