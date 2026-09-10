import { Effect, FileSystem } from "effect";
import type { PlatformError } from "effect/PlatformError";

export type SsoFileErrorReason =
  | "not_found"
  | "permission"
  | "invalid_content"
  | "invalid_url"
  | "other";

function fileErrorReason(cause: PlatformError): SsoFileErrorReason {
  if (cause.reason._tag === "NotFound") return "not_found";
  if (cause.reason._tag === "PermissionDenied") return "permission";
  return "other";
}

/**
 * The `--name-id-format` value set, shared by `sso add` and `sso update`.
 * Order matters: it drives the CLI help text and is joined verbatim into
 * pflag's `invalid argument … must be one of [ … ]` error (`pflagEnumValue`),
 * which must byte-match pflag's format.
 */
export const SSO_NAME_ID_FORMATS = [
  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
  "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
] as const;

/**
 * Validates that raw bytes decode as strict UTF-8. Using
 * `TextDecoder("utf-8", { fatal: true })` makes any malformed surrogate or
 * unexpected continuation byte throw.
 *
 * The `source` argument is the path or URL the bytes came from; it's
 * embedded in the rendered error message so users can locate the bad file.
 */
export function validateMetadataXmlBytes<E>(
  bytes: Uint8Array,
  source: string,
  nonUtf8Error: (args: { readonly source: string; readonly message: string }) => E,
): Effect.Effect<void, E> {
  return Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => undefined,
  }).pipe(
    Effect.mapError(() =>
      nonUtf8Error({
        source,
        message: `SAML Metadata XML at ${JSON.stringify(source)} is not UTF-8 encoded`,
      }),
    ),
    Effect.asVoid,
  );
}

/**
 * Reads a SAML 2.0 metadata XML file and validates UTF-8 encoding.
 * Subcommands inject their own open-error / non-UTF-8 error classes so each
 * handler returns errors in its own tagged-error family.
 */
export const readMetadataFile =
  <Eopen, Eutf>(factory: {
    readonly openError: (args: {
      readonly message: string;
      readonly reason: SsoFileErrorReason;
    }) => Eopen;
    readonly nonUtf8Error: (args: { readonly source: string; readonly message: string }) => Eutf;
  }) =>
  (path: string): Effect.Effect<string, Eopen | Eutf, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // Any open or read failure surfaces as `failed to open metadata file:`,
      // matching the established message for the common case (a missing file).
      const bytes = yield* fs.readFile(path).pipe(
        Effect.mapError((cause) =>
          factory.openError({
            message: `failed to open metadata file: ${String(cause)}`,
            reason: fileErrorReason(cause),
          }),
        ),
      );
      yield* validateMetadataXmlBytes(bytes, path, factory.nonUtf8Error);
      return new TextDecoder("utf-8").decode(bytes);
    });

/**
 * Reads an attribute mapping JSON file. Returns the parsed value as
 * `unknown` so the raw POST/PUT payload preserves user-defined keys like
 * `default` that aren't in the generated `attribute_mapping` schema.
 */
export const readAttributeMappingFile =
  <E>(factory: {
    readonly openError: (args: {
      readonly message: string;
      readonly reason: SsoFileErrorReason;
    }) => E;
  }) =>
  (path: string): Effect.Effect<unknown, E, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const content = yield* fs.readFileString(path).pipe(
        Effect.mapError((cause) =>
          factory.openError({
            message: `failed to open attribute mapping: ${String(cause)}`,
            reason: fileErrorReason(cause),
          }),
        ),
      );
      const parsed = yield* Effect.try({
        try: () => JSON.parse(content) as unknown,
        catch: (cause) =>
          factory.openError({
            message: `failed to parse attribute mapping: ${String(cause)}`,
            reason: "invalid_content",
          }),
      });
      return parsed;
    });
