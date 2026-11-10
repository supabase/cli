import { Effect, Schema } from "effect";
import { CliConfigSchema, RemotesSchema } from "./base.ts";
import { isObject } from "./config-document.ts";
import { normalizeDeprecatedProviderSignupKeys } from "./lib/provider-signup.ts";

const decodeCliConfig = Schema.decodeUnknownEffect(CliConfigSchema);
const decodeCliConfigAll = Schema.decodeUnknownEffect(CliConfigSchema, { errors: "all" });
const decodeRemotesWithoutChecks = Schema.decodeUnknownEffect(RemotesSchema, {
  disableChecks: true,
});
const decodeRemotesWithoutChecksAll = Schema.decodeUnknownEffect(RemotesSchema, {
  disableChecks: true,
  errors: "all",
});

/** Pass `allIssues` to report every schema issue instead of stopping at the first. */
export interface ValidateCliConfigOptions {
  readonly allIssues?: true;
}

/**
 * Decodes a complete CLI config document using the same rules as the config
 * loader: the base document is fully checked, while each remote is decoded
 * structurally with business-rule checks disabled until that remote is
 * selected and merged into the effective config.
 */
export const validateCliConfig = Effect.fn("CliConfig.validate")(function* (
  value: unknown,
  options?: ValidateCliConfigOptions,
) {
  const all = options?.allIssues === true;
  const folded = normalizeDeprecatedProviderSignupKeys(value).document;
  const document = isObject(folded) ? { ...folded, remotes: {} } : folded;
  const config = yield* (all ? decodeCliConfigAll : decodeCliConfig)(document);
  const remotes = isObject(folded) ? folded.remotes : undefined;
  return {
    ...config,
    remotes: yield* (all ? decodeRemotesWithoutChecksAll : decodeRemotesWithoutChecks)(
      remotes ?? {},
    ),
  };
});
