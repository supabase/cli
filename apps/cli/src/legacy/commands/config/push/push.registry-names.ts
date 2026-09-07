/**
 * Registry-derived name lists for `config push`'s auth encoder — hoisted out
 * of push.encoders.ts (B5) so their exact contents are pinned by one unit
 * test rather than re-derived silently wherever they're used.
 *
 * Every list below is computed from `projectConfigMappingRows`
 * (`@supabase/config/internal`), never hand-copied, so a registry change
 * that adds/removes a provider, hook, template, or notification is reflected
 * here automatically.
 */

import { projectConfigMappingRows } from "@supabase/config/internal";

function hasRegistryRowAt(path: ReadonlyArray<string>): boolean {
  return projectConfigMappingRows.some(
    (row) =>
      row.configPath.length === path.length &&
      row.configPath.every((segment, index) => segment === path[index]),
  );
}

/** The external-provider ids, derived from every `["auth","external",id,"enabled"]` registry row. */
export const LEGACY_EXTERNAL_PROVIDER_IDS: ReadonlyArray<string> = (() => {
  const ids: Array<string> = [];
  for (const row of projectConfigMappingRows) {
    if (
      row.configPath.length === 4 &&
      row.configPath[0] === "auth" &&
      row.configPath[1] === "external" &&
      row.configPath[3] === "enabled"
    ) {
      const id = row.configPath[2];
      if (id !== undefined) ids.push(id);
    }
  }
  return ids;
})();

/** Providers with an `external_<id>_url` field — derived from the registry's own `url` rows. */
export const LEGACY_PROVIDERS_WITH_URL: ReadonlyArray<string> = LEGACY_EXTERNAL_PROVIDER_IDS.filter(
  (id) => hasRegistryRowAt(["auth", "external", id, "url"]),
);

/**
 * Providers with an `external_<id>_skip_nonce_check` field — derived from the
 * registry's own `skip_nonce_check` rows (google only, today).
 */
export const LEGACY_PROVIDERS_WITH_SKIP_NONCE_CHECK: ReadonlyArray<string> =
  LEGACY_EXTERNAL_PROVIDER_IDS.filter((id) =>
    hasRegistryRowAt(["auth", "external", id, "skip_nonce_check"]),
  );

/**
 * Providers with an `external_<id>_email_optional` field — derived from the
 * registry's own `email_optional` rows (every provider except workos, today).
 */
export const LEGACY_PROVIDERS_WITH_EMAIL_OPTIONAL: ReadonlyArray<string> =
  LEGACY_EXTERNAL_PROVIDER_IDS.filter((id) =>
    hasRegistryRowAt(["auth", "external", id, "email_optional"]),
  );

/**
 * The SMS provider names. Derived from every `["auth","sms",name,"enabled"]`
 * row whose `apiPath` is `["auth","sms_provider"]` — i.e. rows that select
 * the active provider, rather than report a per-provider credential. This
 * list's iteration order happens to match today's registry declaration
 * order; that order is pinned by this module's own unit test, not guaranteed
 * by the registry itself, so do not depend on it meaning "precedence" beyond
 * what the test asserts.
 */
export const LEGACY_SMS_PROVIDER_NAMES: ReadonlyArray<string> = (() => {
  const names: Array<string> = [];
  for (const row of projectConfigMappingRows) {
    if (
      row.configPath.length === 4 &&
      row.configPath[0] === "auth" &&
      row.configPath[1] === "sms" &&
      row.configPath[3] === "enabled" &&
      row.apiPath.length === 2 &&
      row.apiPath[0] === "auth" &&
      row.apiPath[1] === "sms_provider"
    ) {
      const name = row.configPath[2];
      if (name !== undefined) names.push(name);
    }
  }
  return names;
})();

/** The email template names, derived from the registry's `subject` rows. */
export const LEGACY_EMAIL_TEMPLATE_NAMES: ReadonlyArray<string> = (() => {
  const names: Array<string> = [];
  for (const row of projectConfigMappingRows) {
    if (
      row.configPath.length === 5 &&
      row.configPath[0] === "auth" &&
      row.configPath[1] === "email" &&
      row.configPath[2] === "template" &&
      row.configPath[4] === "subject"
    ) {
      const name = row.configPath[3];
      if (name !== undefined) names.push(name);
    }
  }
  return names;
})();

/** The email notification names, derived from the registry's `enabled` rows. */
export const LEGACY_EMAIL_NOTIFICATION_NAMES: ReadonlyArray<string> = (() => {
  const names: Array<string> = [];
  for (const row of projectConfigMappingRows) {
    if (
      row.configPath.length === 5 &&
      row.configPath[0] === "auth" &&
      row.configPath[1] === "email" &&
      row.configPath[2] === "notification" &&
      row.configPath[4] === "enabled"
    ) {
      const name = row.configPath[3];
      if (name !== undefined) names.push(name);
    }
  }
  return names;
})();
