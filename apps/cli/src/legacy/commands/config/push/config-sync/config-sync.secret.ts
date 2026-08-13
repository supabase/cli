/**
 * Established secret-hashing rules for TOML serialisation of a Secret field.
 *
 * Rules:
 *   - Empty value → "" (no hash prefix).
 *   - Value matching `^env\((.*)\)$` (unresolved env reference) → "" (no hash).
 *   - Value starting with `encrypted:` (dotenvx ciphertext) → decrypt with
 *     `legacyDecryptSecret`, then hash the decrypted plaintext.
 *   - Otherwise → "hash:" + sha256Hmac(projectId, value).
 *
 * `config push`'s handler runs a document-wide decrypt-or-abort pre-check
 * (`push.handler.ts`, reusing `legacyAssertDecryptableSecrets`) immediately
 * after loading `config.toml` and before any network call. By the time the
 * functions below run (deep in the auth service's local/diff computation),
 * decryption is therefore expected to always succeed. They still throw a
 * `failed to parse config: <cause>` error rather than silently gating the
 * secret out, in case that invariant is ever violated by a future field
 * addition.
 */

import { createHmac } from "node:crypto";

import { legacyDecryptSecret } from "../../../../shared/legacy-vault-decrypt.ts";

const ENV_PATTERN = /^env\((.*)\)$/;
const ENCRYPTED_PREFIX = "encrypted:";
const HASHED_PREFIX = "hash:";

/** Decrypts `value` when it's a dotenvx `encrypted:` ciphertext; otherwise returns it unchanged. */
function decryptIfNeeded(value: string, dotenvPrivateKeys: ReadonlyArray<string>): string {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value;
  const decrypted = legacyDecryptSecret(value, dotenvPrivateKeys);
  if (!decrypted.ok) {
    throw new Error(`failed to parse config: ${decrypted.error}`);
  }
  return decrypted.value;
}

/**
 * Returns the TOML serialisation of a Secret field. The project ref is the
 * HMAC key. `dotenvPrivateKeys` are the `DOTENV_PRIVATE_KEY`/
 * `DOTENV_PRIVATE_KEY_*` values (`legacyCollectDotenvPrivateKeys`), used to
 * decrypt an `encrypted:` value before hashing — the decrypted plaintext is
 * always hashed, never the ciphertext.
 *
 * @throws When an `encrypted:` value cannot be decrypted with any key.
 */
export function secretHash(
  projectId: string,
  value: string,
  dotenvPrivateKeys: ReadonlyArray<string>,
): string {
  if (value.length === 0) return "";
  if (ENV_PATTERN.test(value)) return "";
  const plaintext = decryptIfNeeded(value, dotenvPrivateKeys);
  const hmac = createHmac("sha256", projectId).update(plaintext).digest("hex");
  return HASHED_PREFIX + hmac;
}

/**
 * Resolves a Secret field to the plaintext Go sends as `Secret.Value` in the
 * update-request body — decrypting an `encrypted:` value with
 * `dotenvPrivateKeys`, otherwise returning `value` unchanged. Callers gate on
 * {@link secretHash}'s result being non-empty before using this (mirrors Go's
 * `if len(Secret.SHA256) > 0`), so the empty/unresolved-`env()` cases never
 * reach the request body regardless of what this returns for them.
 *
 * @throws When an `encrypted:` value cannot be decrypted with any key.
 */
export function secretPlaintext(value: string, dotenvPrivateKeys: ReadonlyArray<string>): string {
  return decryptIfNeeded(value, dotenvPrivateKeys);
}
