import { Buffer } from "node:buffer";
import { decrypt, PrivateKey } from "eciesjs";

/**
 * dotenvx vault-secret decryption: ECIES over secp256k1 (uncompressed
 * ephemeral key, HKDF-SHA256 with no salt/info, AES-256-GCM with a 16-byte
 * nonce) — the same wire format the JS `eciesjs` library produces, so this
 * decrypts with `eciesjs` directly.
 *
 * An `encrypted:` value that cannot be decrypted aborts the whole command
 * with `failed to parse config: <error>`; the caller maps a non-`ok` result
 * into that error.
 */

const ENCRYPTED_PREFIX = "encrypted:";
const PRIVATE_KEY_ENV_PREFIX = "DOTENV_PRIVATE_KEY";
/** Standard base64 alphabet, with optional `=` padding. */
const STD_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

/** Whether a `[db.vault]` value is a dotenvx ciphertext. */
export const isEncryptedSecret = (value: string): boolean => value.startsWith(ENCRYPTED_PREFIX);

/**
 * Collects dotenvx private keys from the environment: every
 * `DOTENV_PRIVATE_KEY` or `DOTENV_PRIVATE_KEY_*` variable, comma-split with
 * empties dropped. Enumeration order only matters when more than one
 * distinct key could decrypt the same ciphertext (not a real scenario).
 */
export function collectDotenvPrivateKeys(
  env: Record<string, string | undefined>,
): ReadonlyArray<string> {
  const keys: Array<string> = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (name === PRIVATE_KEY_ENV_PREFIX || name.startsWith(`${PRIVATE_KEY_ENV_PREFIX}_`)) {
      for (const key of value.split(",")) {
        if (key.length > 0) keys.push(key);
      }
    }
  }
  return keys;
}

/** Decrypt outcome — plaintext on success, else an error message. */
export type DecryptedSecret =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: string };

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Per-key decrypt: hex key → base64 payload → ECIES. */
function decryptWithKey(keyHex: string, encryptedValue: string): DecryptedSecret {
  if (keyHex.length === 0) return { ok: false, error: "missing private key" };
  let privateKeyHex: string;
  try {
    privateKeyHex = PrivateKey.fromHex(keyHex).toHex();
  } catch {
    // Fixed message, not the underlying error: some runtimes' fallback hex
    // decoder echoes a fragment of the bad input (offending char + index)
    // into the error, which would otherwise reach the user's stderr.
    return { ok: false, error: "failed to hex decode private key: cannot decode hex string" };
  }
  const encoded = encryptedValue.slice(ENCRYPTED_PREFIX.length);
  // Node's `Buffer.from(s, "base64")` silently drops invalid characters, so
  // reject malformed input explicitly.
  if (!STD_BASE64_PATTERN.test(encoded) || encoded.length % 4 !== 0) {
    return { ok: false, error: "failed to base64 decode secret: invalid base64 data" };
  }
  try {
    // eciesjs returns a Uint8Array; wrap in Buffer before decoding the plaintext.
    const plaintext = Buffer.from(decrypt(privateKeyHex, Buffer.from(encoded, "base64")));
    return { ok: true, value: plaintext.toString("utf8") };
  } catch (cause) {
    return { ok: false, error: `failed to decrypt secret: ${errorMessage(cause)}` };
  }
}

/**
 * Decrypts a dotenvx `encrypted:` secret: with no keys, `missing private
 * key`; otherwise tries each key, the first success wins, and on total
 * failure returns the last key's error.
 */
export function decryptSecret(
  encryptedValue: string,
  keys: ReadonlyArray<string>,
): DecryptedSecret {
  if (keys.length === 0) return { ok: false, error: "missing private key" };
  let lastError = "missing private key";
  for (const keyHex of keys) {
    const attempt = decryptWithKey(keyHex, encryptedValue);
    if (attempt.ok) return attempt;
    lastError = attempt.error;
  }
  return { ok: false, error: lastError };
}
