/**
 * Port of Go's `Secret.MarshalText` + `DecryptSecretHookFunc` hash logic from
 * `apps/cli-go/pkg/config/secret.go` and `utils.go`.
 *
 * Rules:
 *   - Empty value → "" (no hash prefix).
 *   - Value matching `^env\((.*)\)$` (unresolved env reference) → "" (no hash).
 *   - Value starting with `encrypted:` (dotenvx ciphertext) → "" (no hash).
 *   - Otherwise → "hash:" + sha256Hmac(projectId, value).
 *
 * NOTE: `encrypted:` dotenvx decryption is not implemented. The Go CLI decrypts
 * such values before hashing and pushes the plaintext; we cannot. Rather than
 * hash and push the ciphertext — which would silently overwrite the remote
 * secret with garbage — we treat `encrypted:` values as unresolved, exactly like
 * `env()` refs: `secretHash` returns "", so the empty hash gates the value out of
 * both the diff and the update body and the remote secret is left untouched.
 * This is a documented residual gap for local dev use of dotenvx secrets
 * (see SIDE_EFFECTS.md).
 */

import { createHmac } from "node:crypto";

const ENV_PATTERN = /^env\((.*)\)$/;
const ENCRYPTED_PREFIX = "encrypted:";
const HASHED_PREFIX = "hash:";

/**
 * Returns the TOML serialisation of a Secret field, mirroring Go's
 * `Secret.MarshalText`. The project ref is the HMAC key.
 */
export function secretHash(projectId: string, value: string): string {
  if (value.length === 0) return "";
  if (ENV_PATTERN.test(value)) return "";
  if (value.startsWith(ENCRYPTED_PREFIX)) return "";
  const hmac = createHmac("sha256", projectId).update(value).digest("hex");
  return HASHED_PREFIX + hmac;
}
