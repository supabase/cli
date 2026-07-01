import { Buffer } from "node:buffer";
import { decrypt, PrivateKey } from "eciesjs";

/**
 * dotenvx vault-secret decryption — a port of Go's `config.Secret.Decrypt`
 * (`apps/cli-go/pkg/config/secret.go:30-73`). Go decrypts with
 * `github.com/ecies/go/v2`: ECIES over secp256k1 (uncompressed ephemeral key,
 * HKDF-SHA256 with no salt/info, AES-256-GCM with a 16-byte nonce). dotenvx
 * itself encrypts with the JS `eciesjs` library, whose defaults match that wire
 * format byte-for-byte, so we decrypt with `eciesjs` here. Validated against
 * Go's test vector (`pkg/config/secret_test.go`).
 *
 * Go runs this inside `config.Load` (the `DecryptSecretHookFunc` decode hook),
 * so an `encrypted:` value that cannot be decrypted aborts the whole command
 * with `failed to parse config: <error>` — it is never silently skipped. The
 * caller maps a non-`ok` result into that error.
 */

/** Go's `ENCRYPTED_PREFIX` (`secret.go:28`). */
const ENCRYPTED_PREFIX = "encrypted:";
/** Go's `PRIVATE_KEY_PREFIX` (`secret.go:75`). */
const PRIVATE_KEY_ENV_PREFIX = "DOTENV_PRIVATE_KEY";
/** Standard base64 alphabet (Go's `base64.StdEncoding`), optional `=` padding. */
const STD_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

/** Whether a `[db.vault]` value is a dotenvx ciphertext (Go's `ENCRYPTED_PREFIX`). */
export const legacyIsEncryptedSecret = (value: string): boolean =>
  value.startsWith(ENCRYPTED_PREFIX);

/**
 * Collects dotenvx private keys from the environment, mirroring Go's env scan
 * (`secret.go:77-85`): every `DOTENV_PRIVATE_KEY` or `DOTENV_PRIVATE_KEY_*`
 * variable, comma-split (Go's `strToArr`, empties dropped). The decrypt loop
 * tries each key until one succeeds, so enumeration order only matters when more
 * than one distinct key could decrypt the same ciphertext (not a real scenario).
 */
export function legacyCollectDotenvPrivateKeys(
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

/** Decrypt outcome — plaintext on success, else Go's error message. */
export type LegacyDecryptedSecret =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly error: string };

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Go's per-key `decrypt` (`secret.go:52-73`): hex key → base64 payload → ECIES. */
function decryptWithKey(keyHex: string, encryptedValue: string): LegacyDecryptedSecret {
  if (keyHex.length === 0) return { ok: false, error: "missing private key" };
  let privateKeyHex: string;
  try {
    privateKeyHex = PrivateKey.fromHex(keyHex).toHex();
  } catch (cause) {
    return { ok: false, error: `failed to hex decode private key: ${errorMessage(cause)}` };
  }
  const encoded = encryptedValue.slice(ENCRYPTED_PREFIX.length);
  // Node's `Buffer.from(s, "base64")` silently drops invalid characters, unlike
  // Go's `base64.StdEncoding.DecodeString`, so reject malformed input explicitly.
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
 * Decrypts a dotenvx `encrypted:` secret — a port of Go's `Secret.Decrypt`
 * (`secret.go:30-46`): with no keys, `missing private key`; otherwise try each
 * key, the first success wins, and on total failure return the last key's error.
 */
export function legacyDecryptSecret(
  encryptedValue: string,
  keys: ReadonlyArray<string>,
): LegacyDecryptedSecret {
  if (keys.length === 0) return { ok: false, error: "missing private key" };
  let lastError = "missing private key";
  for (const keyHex of keys) {
    const attempt = decryptWithKey(keyHex, encryptedValue);
    if (attempt.ok) return attempt;
    lastError = attempt.error;
  }
  return { ok: false, error: lastError };
}
