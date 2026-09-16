import { Effect, Schema } from "effect";
import { CliConfigSchema, RemotesSchema } from "./base.ts";
import { isObject } from "./config-document.ts";

const decodeCliConfig = Schema.decodeUnknownEffect(CliConfigSchema);
const decodeRemotesWithoutChecks = Schema.decodeUnknownEffect(RemotesSchema, {
  disableChecks: true,
});

/**
 * Decodes a complete CLI config document using the same rules as the config
 * loader: the base document is fully checked, while each remote is decoded
 * structurally with business-rule checks disabled until that remote is
 * selected and merged into the effective config.
 */
export const validateCliConfig = Effect.fnUntraced(function* (value: unknown) {
  const document = isObject(value) ? { ...value, remotes: {} } : value;
  const config = yield* decodeCliConfig(document);
  const remotes = isObject(value) ? value.remotes : undefined;
  return { ...config, remotes: yield* decodeRemotesWithoutChecks(remotes ?? {}) };
});
