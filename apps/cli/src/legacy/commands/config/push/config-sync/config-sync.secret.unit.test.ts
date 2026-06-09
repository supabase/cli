/**
 * Unit tests for config-sync.secret.ts — golden parity with Go's
 * `Secret.MarshalText` (`apps/cli-go/pkg/config/secret.go`).
 *
 * The HMAC keys/values below were captured from the same `createHmac` the port
 * uses; they lock the exact `hash:<sha256hex>` serialisation Go emits.
 */

import { describe, expect, it } from "vitest";

import { secretHash } from "./config-sync.secret.ts";

describe("secretHash", () => {
  it("returns the hash:<hmac> form for a plaintext secret", () => {
    expect(secretHash("abcdefghijklmnopqrst", "my-secret")).toBe(
      "hash:64800db722cc0be9e1d816d5aed626805e91a939d2dbcbc5239cd31eeef763e9",
    );
    expect(secretHash("test", "topsecret")).toBe(
      "hash:8eed2826599c798e072951884ced30954f8322fa1c3648506634e8376a740d72",
    );
  });

  it("keys the HMAC on the project ref (same value, different ref → different hash)", () => {
    expect(secretHash("ref-a", "same")).not.toBe(secretHash("ref-b", "same"));
  });

  it("returns '' for an empty value", () => {
    expect(secretHash("abcdefghijklmnopqrst", "")).toBe("");
  });

  it("returns '' for an unresolved env() reference", () => {
    expect(secretHash("abcdefghijklmnopqrst", "env(MY_SECRET)")).toBe("");
    expect(secretHash("abcdefghijklmnopqrst", "env()")).toBe("");
  });

  it("returns '' for a dotenvx encrypted: value (never hashes/pushes ciphertext)", () => {
    // Regression: hashing/pushing the ciphertext would overwrite the remote
    // secret with garbage. Treated as unresolved, like env().
    expect(secretHash("abcdefghijklmnopqrst", "encrypted:BvEYU1pXk9...")).toBe("");
  });

  it("hashes a value that merely contains (but does not start with) 'encrypted:'", () => {
    // Only the dotenvx prefix is special; an embedded substring is a real secret.
    expect(secretHash("test", "not-encrypted:value")).toBe(
      secretHash("test", "not-encrypted:value"),
    );
    expect(secretHash("test", "not-encrypted:value").startsWith("hash:")).toBe(true);
  });
});
