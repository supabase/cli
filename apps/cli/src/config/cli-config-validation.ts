import {
  decodeCliConfigDocumentForValidationEffect,
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

/** How many times a validation load deletes failing keys and decodes again before it gives up. */
export const MAX_PRUNE_ROUNDS = 5;
