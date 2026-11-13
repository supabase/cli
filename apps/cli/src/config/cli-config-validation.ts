import {
  decodeCliConfigDocumentForValidationEffect,
  decodeCliConfigWithoutTableRules as decodeDocumentWithoutTableRules,
  type DecodeCliConfigDocumentForValidationEffectOptions,
} from "@supabase/config/internal";

export type CliConfigValidationOptions = Omit<
  DecodeCliConfigDocumentForValidationEffectOptions,
  "cliCompat"
>;

/** Decodes a pending config document with the CLI's own decode semantics. */
export const decodeCliConfigDocumentForValidation = (
  document: Record<string, unknown>,
  options: CliConfigValidationOptions,
) => decodeCliConfigDocumentForValidationEffect(document, { ...options, cliCompat: true });

/** Decodes a document with leaf rules only and the CLI's own list coercion, collecting every issue. */
export const decodeCliConfigWithoutTableRules = (document: unknown) =>
  decodeDocumentWithoutTableRules(document, { cliCompat: true });
