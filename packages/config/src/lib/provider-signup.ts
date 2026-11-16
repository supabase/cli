/** `[auth.email]`/`[auth.sms]` keys where the preferred `enabled` replaces the legacy `enable_signup`. */
export const PROVIDER_SIGNUP_ALIASES = [
  { path: ["auth", "email"], preferred: "enabled", legacy: "enable_signup" },
  { path: ["auth", "sms"], preferred: "enabled", legacy: "enable_signup" },
] as const;

export interface NormalizedProviderSignupDocument<T = unknown> {
  readonly document: T;
  /**
   * Dotted paths of every present legacy `enable_signup`, whatever its value, e.g.
   * `auth.email.enable_signup` or `remotes.staging.auth.sms.enable_signup`.
   */
  readonly deprecatedPaths: ReadonlyArray<string>;
}

type DocumentLayer = Record<string, unknown>;
type RenameDirection = "toLegacy" | "toPreferred";

// Kept local, like `sparse.ts`, so this module does not import `config-document.ts`, which imports it.
function isObject(value: unknown): value is DocumentLayer {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renameSectionKey(
  section: DocumentLayer,
  { preferred, legacy }: { readonly preferred: string; readonly legacy: string },
  direction: RenameDirection,
): DocumentLayer {
  const [from, to] = direction === "toLegacy" ? [preferred, legacy] : [legacy, preferred];
  if (!(from in section)) {
    return section;
  }
  const value = preferred in section ? section[preferred] : section[from];
  return Object.fromEntries(
    Object.entries(section).flatMap(([key, entry]): Array<[string, unknown]> =>
      key === from ? [[to, value]] : key === to ? [] : [[key, entry]],
    ),
  );
}

function renameProviderSignupKeys(
  layer: DocumentLayer,
  direction: RenameDirection,
  onLegacyKey?: (keyPath: ReadonlyArray<string>) => void,
): DocumentLayer {
  let renamed = layer;
  for (const alias of PROVIDER_SIGNUP_ALIASES) {
    const [parentKey, sectionKey] = alias.path;
    const parent = renamed[parentKey];
    const section = isObject(parent) ? parent[sectionKey] : undefined;
    if (!isObject(parent) || !isObject(section)) {
      continue;
    }
    if (alias.legacy in section) {
      onLegacyKey?.([parentKey, sectionKey, alias.legacy]);
    }
    const next = renameSectionKey(section, alias, direction);
    if (next !== section) {
      renamed = { ...renamed, [parentKey]: { ...parent, [sectionKey]: next } };
    }
  }
  return renamed;
}

/** Applies `rewrite` to the top level and to each `[remotes.*]` block, passing the block's dotted path prefix. */
function rewriteLayers(
  document: DocumentLayer,
  rewrite: (layer: DocumentLayer, prefix: string) => DocumentLayer,
): DocumentLayer {
  const top = rewrite(document, "");
  if (!isObject(top.remotes)) {
    return top;
  }
  return {
    ...top,
    remotes: Object.fromEntries(
      Object.entries(top.remotes).map(([name, remote]) => [
        name,
        isObject(remote) ? rewrite(remote, `remotes.${name}.`) : remote,
      ]),
    ),
  };
}

/**
 * Folds `auth.{email,sms}.enabled` into the canonical `enable_signup` (the new key wins),
 * separately for the top level and each `[remotes.*]` block so a remote's own key beats the base's.
 */
export function normalizeDeprecatedProviderSignupKeys(
  document: DocumentLayer,
): NormalizedProviderSignupDocument<DocumentLayer>;
export function normalizeDeprecatedProviderSignupKeys(
  document: unknown,
): NormalizedProviderSignupDocument;
export function normalizeDeprecatedProviderSignupKeys(
  document: unknown,
): NormalizedProviderSignupDocument {
  if (!isObject(document)) {
    return { document, deprecatedPaths: [] };
  }
  const deprecatedPaths: Array<string> = [];
  const normalized = rewriteLayers(document, (layer, prefix) =>
    renameProviderSignupKeys(layer, "toLegacy", (keyPath) => {
      deprecatedPaths.push(`${prefix}${keyPath.join(".")}`);
    }),
  );
  return { document: normalized, deprecatedPaths };
}

/** Rewrites each `auth.{email,sms}.enable_signup` to the preferred `enabled`, per layer; an `enabled` already present wins. */
export function writeProviderSignupPreferredKeys(document: DocumentLayer): DocumentLayer {
  return rewriteLayers(document, (layer) => renameProviderSignupKeys(layer, "toPreferred"));
}
