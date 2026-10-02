import { Effect, type Crypto, type PlatformError } from "effect";

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** A 16-character hex SHA-256 prefix, used to name content-addressed files and directories. */
export const contentDigestHex = (
  crypto: Crypto.Crypto,
  content: string,
): Effect.Effect<string, PlatformError.PlatformError> =>
  crypto
    .digest("SHA-256", new TextEncoder().encode(content))
    .pipe(Effect.map((digest) => hex(digest).slice(0, 16)));
