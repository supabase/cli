import { operationDefinitions } from "@supabase/api/effect";
import { Effect, FileSystem, Predicate, Schema, SchemaIssue } from "effect";
import type { PlatformError } from "effect/PlatformError";

import { quoteSsoString } from "./sso.format.ts";

export type SsoFileErrorReason =
  | "not_found"
  | "permission"
  | "invalid_content"
  | "invalid_url"
  | "other";

function fileErrorReason(cause: PlatformError): SsoFileErrorReason {
  if (Predicate.isTagged(cause.reason, "NotFound")) return "not_found";
  if (Predicate.isTagged(cause.reason, "PermissionDenied")) return "permission";
  return "other";
}

export type SsoNameIdFormat = (typeof SSO_NAME_ID_FORMATS)[number];

/**
 * The `--name-id-format` value set, shared by `sso add` and `sso update`.
 * Order matters: it drives the CLI help text and is joined verbatim into
 * the `invalid argument … must be one of [ … ]` error (`argvEnumValue`),
 * whose format is byte-exact.
 */
export const SSO_NAME_ID_FORMATS = [
  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
  "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
  "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
  "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
] as const;

/** Narrows a pflag-validated `--name-id-format` value to the API's literal union. */
export const toNameIdFormat = (value: string): SsoNameIdFormat | undefined =>
  SSO_NAME_ID_FORMATS.find((format) => format === value);

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
    catch: () =>
      nonUtf8Error({
        source,
        message: `SAML Metadata XML at ${quoteSsoString(source)} is not UTF-8 encoded`,
      }),
  }).pipe(Effect.asVoid);
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

const attributeMappingSchema =
  operationDefinitions.v1CreateASsoProvider.inputSchema.fields.attribute_mapping;
const decodeAttributeMapping = Schema.decodeUnknownEffect(attributeMappingSchema);
const formatSchemaIssue = SchemaIssue.makeFormatterDefault();

export type SsoAttributeMapping = Schema.Schema.Type<typeof attributeMappingSchema>;

/**
 * Reads an attribute mapping JSON file and validates it against the Management
 * API `attribute_mapping` schema; keys the API does not model are rejected.
 */
export const readAttributeMappingFile =
  <E>(factory: {
    readonly openError: (args: {
      readonly message: string;
      readonly reason: SsoFileErrorReason;
    }) => E;
  }) =>
  (path: string): Effect.Effect<SsoAttributeMapping, E, FileSystem.FileSystem> =>
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
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- Native parser errors are CLI output; schema decoding discards their messages.
        try: (): unknown => JSON.parse(content),
        catch: (cause) =>
          factory.openError({
            message: `failed to parse attribute mapping: ${String(cause)}`,
            reason: "invalid_content",
          }),
      });
      return yield* decodeAttributeMapping(parsed, {
        onExcessProperty: "error",
        errors: "all",
      }).pipe(
        Effect.mapError((cause) =>
          factory.openError({
            message: `failed to parse attribute mapping: ${formatSchemaIssue(cause.issue).replace(/\s*\n\s*/g, " ")}`,
            reason: "invalid_content",
          }),
        ),
      );
    });
