import { Effect } from "effect";
import { isObject } from "./config-document.ts";
import type { ConfigFormat } from "./config-format.ts";
import { CliConfigRemovedKeyError } from "./errors.ts";

type RemovedConfigKey = CliConfigRemovedKeyError["removedKeys"][number];

const REMOVED_EXTERNAL_PROVIDERS = ["linkedin", "slack"] as const;

function scanScope(
  scope: Record<string, unknown>,
  prefix: string,
): {
  readonly removedKeys: ReadonlyArray<RemovedConfigKey>;
  readonly scope: Record<string, unknown>;
} {
  const removedKeys: Array<RemovedConfigKey> = [];
  let stripped = scope;

  if (Object.hasOwn(scope, "inbucket")) {
    removedKeys.push({ key: `[${prefix}inbucket]`, replacement: `[${prefix}local_smtp]` });
  }

  const experimental = scope["experimental"];
  if (isObject(experimental) && Object.hasOwn(experimental, "orioledb_version")) {
    if (experimental["orioledb_version"] === "") {
      const withoutEmptyVersion = { ...experimental };
      delete withoutEmptyVersion["orioledb_version"];
      stripped = { ...scope, experimental: withoutEmptyVersion };
    } else {
      removedKeys.push({
        key: `${prefix}experimental.orioledb_version`,
        replacement: `${prefix}db.orioledb_version`,
      });
    }
  }

  const auth = scope["auth"];
  const external = isObject(auth) ? auth["external"] : undefined;
  if (isObject(external)) {
    for (const provider of REMOVED_EXTERNAL_PROVIDERS) {
      if (Object.hasOwn(external, provider)) {
        removedKeys.push({
          key: `[${prefix}auth.external.${provider}]`,
          replacement: `[${prefix}auth.external.${provider}_oidc]`,
        });
      }
    }
  }

  return { removedKeys, scope: stripped };
}

/**
 * Finds every removed key in a raw document, top level and each `[remotes.*]` block alike. The
 * returned document drops an empty `experimental.orioledb_version`, which older `supabase init`
 * templates wrote and which carries no meaning.
 */
function detectRemovedConfigKeys(document: Record<string, unknown>): {
  readonly removedKeys: ReadonlyArray<RemovedConfigKey>;
  readonly document: Record<string, unknown>;
} {
  const root = scanScope(document, "");
  const removedKeys = [...root.removedKeys];
  const remotes = document["remotes"];
  if (!isObject(remotes)) {
    return { removedKeys, document: root.scope };
  }
  const strippedRemotes = Object.fromEntries(
    Object.entries(remotes).map(([name, remote]) => {
      if (!isObject(remote)) {
        return [name, remote];
      }
      const scanned = scanScope(remote, `remotes.${name}.`);
      removedKeys.push(...scanned.removedKeys);
      return [name, scanned.scope];
    }),
  );
  return { removedKeys, document: { ...root.scope, remotes: strippedRemotes } };
}

/** Fails with every removed key the raw document uses; otherwise yields it without the tolerated empty `experimental.orioledb_version`. */
export const rejectRemovedConfigKeys = (
  document: Record<string, unknown>,
  path: string,
  format: ConfigFormat,
): Effect.Effect<Record<string, unknown>, CliConfigRemovedKeyError> => {
  const { removedKeys, document: stripped } = detectRemovedConfigKeys(document);
  return removedKeys.length === 0
    ? Effect.succeed(stripped)
    : Effect.fail(new CliConfigRemovedKeyError({ path, format, removedKeys }));
};
