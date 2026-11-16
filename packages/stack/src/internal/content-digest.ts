import { Effect } from "effect";
import { Digest } from "effect/crypto";

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** A 16-character hex SHA-256 prefix, used to name content-addressed files and directories. */
export const contentDigestHex = (
  digest: Digest.Digest["Service"],
  content: string,
): Effect.Effect<string> =>
  digest
    .digest(Digest.sha256, new TextEncoder().encode(content))
    .pipe(Effect.map((bytes) => hex(bytes).slice(0, 16)));
