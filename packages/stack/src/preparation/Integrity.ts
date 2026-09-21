import { Crypto, Effect } from "effect";
import { ArtifactIntegrityError, PreparationError } from "./Errors.ts";

const SHA256 = /^[0-9a-f]{64}$/i;

const integrityError = (message: string, fields: Readonly<Record<string, unknown>> = {}) =>
  new ArtifactIntegrityError({ ...fields, message });

/** Validates the hexadecimal SHA-256 identifier supplied by an artifact catalog. */
export const validateSha256 = Effect.fn("Integrity.validateSha256")(function* (value: string) {
  if (SHA256.test(value)) return value.toLowerCase();
  return yield* integrityError("Artifact SHA-256 must be exactly 64 hexadecimal characters", {
    expected: value,
  });
});

/** Converts a digest returned by the Effect Crypto service to its canonical hexadecimal form. */
export const digestHex = (digest: Uint8Array): string =>
  Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Computes and verifies a SHA-256 digest without collapsing Crypto failures. */
export const verifySha256 = Effect.fn("Integrity.verifySha256")(function* (
  bytes: Uint8Array,
  expected: string,
) {
  yield* Effect.gen(function* () {
    const canonical = yield* validateSha256(expected);
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto
      .digest("SHA-256", bytes)
      .pipe(
        Effect.mapError((cause) =>
          integrityError("Unable to compute artifact SHA-256", { expected: canonical, cause }),
        ),
      );
    const actual = digestHex(digest);
    if (actual !== canonical)
      return yield* integrityError("Artifact SHA-256 does not match the catalog", {
        expected: canonical,
        actual,
      });
  });
});

/** Validates one relative artifact path before it is joined to a cache root. */
export const validateRelativePath = Effect.fn("Integrity.validateRelativePath")(function* (
  value: string,
  field: string,
) {
  const segments = value.split(/[\\/]/u);
  if (
    value.length === 0 ||
    value.includes("\u0000") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === ".." || segment.includes(":"),
    )
  )
    return yield* new PreparationError({
      field,
      value,
      message: `${field} must be a non-empty relative path without traversal`,
    });
  return;
});
