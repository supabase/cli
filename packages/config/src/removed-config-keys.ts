import { Effect } from "effect";
import type { ConfigFormat } from "./config-format.ts";
import { CliConfigRemovedKeyError } from "./errors.ts";
import { detectRemovedConfigKeys, type RemovedConfigKey } from "./removed-config-keys-core.ts";

/** Fails with every removed key the raw document uses; otherwise yields it without the tolerated empty `experimental.orioledb_version`. */
export const rejectRemovedConfigKeys = (
  document: Record<string, unknown>,
  path: string,
  format: ConfigFormat,
): Effect.Effect<Record<string, unknown>, CliConfigRemovedKeyError> => {
  const { removedKeys, document: stripped } = detectRemovedConfigKeys(document, false);
  return removedKeys.length === 0
    ? Effect.succeed(stripped)
    : Effect.fail(new CliConfigRemovedKeyError({ path, format, removedKeys }));
};

/** Every removed key the raw document uses, and the document with each of them deleted. */
export const stripRemovedConfigKeys = (
  document: Record<string, unknown>,
): {
  readonly removedKeys: ReadonlyArray<RemovedConfigKey>;
  readonly document: Record<string, unknown>;
} => detectRemovedConfigKeys(document, true);
