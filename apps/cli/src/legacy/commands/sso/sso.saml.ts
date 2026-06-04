import { Effect, FileSystem } from "effect";

/**
 * Validates that raw bytes decode as strict UTF-8. Mirrors Go's
 * `unicode/utf8.Valid(data)` check inside `saml.ValidateMetadata`. Using
 * `TextDecoder("utf-8", { fatal: true })` makes any malformed surrogate or
 * unexpected continuation byte throw, matching Go's strict semantics.
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
      // Verbatim Go message from `saml/files.go:55-57`.
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
 * Subcommands inject their own open-error / non-UTF-8 error classes so
 * each handler returns errors in its own tagged-error family
 * (matches Go, which raises `failed to open metadata file:` / etc.).
 */
export const readMetadataFile =
  <Eopen, Eutf>(factory: {
    readonly openError: (args: { readonly message: string }) => Eopen;
    readonly nonUtf8Error: (args: { readonly source: string; readonly message: string }) => Eutf;
  }) =>
  (path: string): Effect.Effect<string, Eopen | Eutf, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // Go uses afero `fsys.Open(path)` + `io.ReadAll(file)`; collapsed to a
      // single error branch here (any open / read failure surfaces as
      // `failed to open metadata file:` to match the externally observable
      // string for the common case — missing file).
      const bytes = yield* fs
        .readFile(path)
        .pipe(
          Effect.mapError((cause) =>
            factory.openError({ message: `failed to open metadata file: ${String(cause)}` }),
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
  <E>(factory: { readonly openError: (args: { readonly message: string }) => E }) =>
  (path: string): Effect.Effect<unknown, E, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const content = yield* fs
        .readFileString(path)
        .pipe(
          Effect.mapError((cause) =>
            factory.openError({ message: `failed to open attribute mapping: ${String(cause)}` }),
          ),
        );
      const parsed = yield* Effect.try({
        try: () => JSON.parse(content) as unknown,
        catch: (cause) =>
          factory.openError({ message: `failed to parse attribute mapping: ${String(cause)}` }),
      });
      return parsed;
    });
