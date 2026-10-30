import { isObject } from "../config-document.ts";

/** `[auth.email]`/`[auth.sms]` keys where the preferred `enabled` replaces the legacy `enable_signup`. */
export const PROVIDER_SIGNUP_ALIASES = [
  { path: ["auth", "email"], preferred: "enabled", legacy: "enable_signup" },
  { path: ["auth", "sms"], preferred: "enabled", legacy: "enable_signup" },
] as const;

export interface NormalizedProviderSignupDocument {
  readonly document: unknown;
  /**
   * Dotted paths of every present legacy `enable_signup`, whatever its value, e.g.
   * `auth.email.enable_signup` or `remotes.staging.auth.sms.enable_signup`.
   */
  readonly deprecatedPaths: ReadonlyArray<string>;
}

function foldProviderSignupKeys(
  layer: Record<string, unknown>,
  prefix: string,
): { readonly layer: Record<string, unknown>; readonly deprecatedPaths: ReadonlyArray<string> } {
  const deprecatedPaths: Array<string> = [];
  let normalized = layer;
  for (const {
    path: [parentKey, sectionKey],
    preferred,
    legacy,
  } of PROVIDER_SIGNUP_ALIASES) {
    const parent = normalized[parentKey];
    const section = isObject(parent) ? parent[sectionKey] : undefined;
    if (!isObject(parent) || !isObject(section)) {
      continue;
    }
    if (legacy in section) {
      deprecatedPaths.push(`${prefix}${parentKey}.${sectionKey}.${legacy}`);
    }
    if (preferred in section) {
      const { [preferred]: value, ...rest } = section;
      normalized = {
        ...normalized,
        [parentKey]: { ...parent, [sectionKey]: { ...rest, [legacy]: value } },
      };
    }
  }
  return { layer: normalized, deprecatedPaths };
}

/**
 * Folds `auth.{email,sms}.enabled` into the canonical `enable_signup` (the new key wins),
 * separately for the top level and each `[remotes.*]` block so a remote's own key beats the base's.
 */
export function normalizeDeprecatedProviderSignupKeys(
  document: unknown,
): NormalizedProviderSignupDocument {
  if (!isObject(document)) {
    return { document, deprecatedPaths: [] };
  }
  const top = foldProviderSignupKeys(document, "");
  const deprecatedPaths = [...top.deprecatedPaths];
  let normalized = top.layer;
  if (isObject(normalized.remotes)) {
    normalized = {
      ...normalized,
      remotes: Object.fromEntries(
        Object.entries(normalized.remotes).map(([name, remote]) => {
          if (!isObject(remote)) {
            return [name, remote];
          }
          const result = foldProviderSignupKeys(remote, `remotes.${name}.`);
          deprecatedPaths.push(...result.deprecatedPaths);
          return [name, result.layer];
        }),
      ),
    };
  }
  return { document: normalized, deprecatedPaths };
}
