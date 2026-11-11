import { Effect } from "effect";
import { isObject } from "./config-document.ts";
import type { ConfigFormat } from "./config-format.ts";
import { CliConfigRemovedKeyError } from "./errors.ts";

type RemovedConfigKey = CliConfigRemovedKeyError["removedKeys"][number];

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

const tomlSegment = (segment: string): string =>
  BARE_KEY.test(segment) ? segment : JSON.stringify(segment);

const removed = (
  remote: string | undefined,
  local: ReadonlyArray<string>,
  replacementLocal: ReadonlyArray<string>,
  table: boolean,
): RemovedConfigKey => {
  const render = (segments: ReadonlyArray<string>): string => {
    const dotted = [...(remote === undefined ? [] : ["remotes", remote]), ...segments]
      .map(tomlSegment)
      .join(".");
    return table ? `[${dotted}]` : dotted;
  };
  return {
    key: render(local),
    replacement: render(replacementLocal),
    path: local,
    replacementPath: replacementLocal,
    ...(remote === undefined ? {} : { remote }),
  };
};

const REMOVED_EXTERNAL_PROVIDERS = ["linkedin", "slack"] as const;

function scanScope(
  scope: Record<string, unknown>,
  remote: string | undefined,
  dropRemoved: boolean,
): {
  readonly removedKeys: ReadonlyArray<RemovedConfigKey>;
  readonly scope: Record<string, unknown>;
} {
  const removedKeys: Array<RemovedConfigKey> = [];
  let stripped = scope;

  if (Object.hasOwn(scope, "inbucket")) {
    removedKeys.push(removed(remote, ["inbucket"], ["local_smtp"], true));
    if (dropRemoved) {
      stripped = { ...stripped };
      delete stripped["inbucket"];
    }
  }

  const experimental = scope["experimental"];
  if (isObject(experimental) && Object.hasOwn(experimental, "orioledb_version")) {
    if (experimental["orioledb_version"] === "") {
      const withoutEmptyVersion = { ...experimental };
      delete withoutEmptyVersion["orioledb_version"];
      stripped = { ...stripped, experimental: withoutEmptyVersion };
    } else {
      removedKeys.push(
        removed(remote, ["experimental", "orioledb_version"], ["db", "orioledb_version"], false),
      );
      if (dropRemoved) {
        const withoutVersion = { ...experimental };
        delete withoutVersion["orioledb_version"];
        stripped = { ...stripped, experimental: withoutVersion };
      }
    }
  }

  const auth = scope["auth"];
  const external = isObject(auth) ? auth["external"] : undefined;
  if (isObject(external)) {
    for (const provider of REMOVED_EXTERNAL_PROVIDERS) {
      if (Object.hasOwn(external, provider)) {
        removedKeys.push(
          removed(
            remote,
            ["auth", "external", provider],
            ["auth", "external", `${provider}_oidc`],
            true,
          ),
        );
        if (dropRemoved) {
          const strippedAuth = stripped["auth"];
          const strippedExternal = isObject(strippedAuth) ? strippedAuth["external"] : undefined;
          if (isObject(strippedAuth) && isObject(strippedExternal)) {
            const withoutProvider = { ...strippedExternal };
            delete withoutProvider[provider];
            stripped = {
              ...stripped,
              auth: { ...strippedAuth, external: withoutProvider },
            };
          }
        }
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
function detectRemovedConfigKeys(
  document: Record<string, unknown>,
  dropRemoved: boolean,
): {
  readonly removedKeys: ReadonlyArray<RemovedConfigKey>;
  readonly document: Record<string, unknown>;
} {
  const root = scanScope(document, undefined, dropRemoved);
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
      const scanned = scanScope(remote, name, dropRemoved);
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
