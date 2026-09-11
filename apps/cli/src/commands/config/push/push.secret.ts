/**
 * Secret-hashing rules for `config push`. See {@link secretDigestHex} for exact behavior.
 *
 * `config push`'s handler runs a document-wide decrypt-or-abort pre-check before any network
 * call, so decryption below is expected to always succeed; these functions still throw rather
 * than silently gating the secret out, in case that invariant is ever violated.
 */

import { createHmac } from "node:crypto";

import { decryptSecret } from "../../../command-internal/vault-decrypt.ts";

const ENV_PATTERN = /^env\((.*)\)$/;
const ENCRYPTED_PREFIX = "encrypted:";

/** Decrypts `value` when it's a dotenvx `encrypted:` ciphertext; otherwise returns it unchanged. */
function decryptIfNeeded(value: string, dotenvPrivateKeys: ReadonlyArray<string>): string {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value;
  const decrypted = decryptSecret(value, dotenvPrivateKeys);
  if (!decrypted.ok) {
    throw new Error(`failed to parse config: ${decrypted.error}`);
  }
  return decrypted.value;
}

/**
 * Returns the bare-hex digest of a secret field, `sha256Hmac(projectRef, plaintext)`, or
 * `undefined` for an empty value or an unresolved `env(...)` reference — the two cases the field
 * is never sent for. `dotenvPrivateKeys` decrypts an `encrypted:` value before hashing; the
 * decrypted plaintext is always hashed, never the ciphertext.
 *
 * @throws When an `encrypted:` value cannot be decrypted with any key.
 */
export function secretDigestHex(
  projectId: string,
  value: string,
  dotenvPrivateKeys: ReadonlyArray<string>,
): string | undefined {
  if (value.length === 0) return undefined;
  if (ENV_PATTERN.test(value)) return undefined;
  const plaintext = decryptIfNeeded(value, dotenvPrivateKeys);
  return createHmac("sha256", projectId).update(plaintext).digest("hex");
}

/**
 * Resolves a secret field to the plaintext value an update request body sends: decrypts an
 * `encrypted:` value with `dotenvPrivateKeys`, otherwise returns `value` unchanged. Callers gate
 * on {@link secretDigestHex}'s result being defined first, so an empty or unresolved-`env()`
 * value never reaches the request body regardless of what this returns.
 *
 * @throws When an `encrypted:` value cannot be decrypted with any key.
 */
export function secretPlaintext(value: string, dotenvPrivateKeys: ReadonlyArray<string>): string {
  return decryptIfNeeded(value, dotenvPrivateKeys);
}
