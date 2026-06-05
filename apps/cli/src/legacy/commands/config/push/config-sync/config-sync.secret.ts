/**
 * Port of Go's `Secret.MarshalText` + `DecryptSecretHookFunc` hash logic from
 * `apps/cli-go/pkg/config/secret.go` and `utils.go`.
 *
 * Rules:
 *   - Empty value → "" (no hash prefix).
 *   - Value matching `^env\((.*)\)$` (unresolved env reference) → "" (no hash).
 *   - Otherwise → "hash:" + sha256Hmac(projectId, value).
 *
 * NOTE: `encrypted:` dotenvx decryption is not implemented — values starting
 * with "encrypted:" are hashed verbatim, unlike the Go CLI which decrypts them
 * first. This is a documented residual gap for local dev use of dotenvx secrets.
 */

import { createHmac } from "node:crypto";

const ENV_PATTERN = /^env\((.*)\)$/;
const HASHED_PREFIX = "hash:";

/**
 * Returns the TOML serialisation of a Secret field, mirroring Go's
 * `Secret.MarshalText`. The project ref is the HMAC key.
 */
export function secretHash(projectId: string, value: string): string {
  if (value.length === 0) return "";
  if (ENV_PATTERN.test(value)) return "";
  const hmac = createHmac("sha256", projectId).update(value).digest("hex");
  return HASHED_PREFIX + hmac;
}
