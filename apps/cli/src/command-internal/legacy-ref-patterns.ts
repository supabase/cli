/**
 * Service-free ref/branch identifier patterns, shared by the resolver
 * machinery and pure formatters alike — a formatter documented as "no
 * Effect, no services" must not pull a service-bearing module into its
 * dependency graph just to reach a regex.
 */

/**
 * Project ref pattern shared by every Management-API endpoint that accepts a
 * 20-lowercase-letter project reference.
 */
export const LEGACY_BRANCH_PROJECT_REF_PATTERN = /^[a-z]{20}$/;

/**
 * Permissive UUID pattern (any 8-4-4-4-12 hex sequence) — accepts any RFC 4122
 * variant including v6/v7 and version 0, matching the established liberal
 * acceptance rather than the v1–v5 + variant-1 subset.
 */
export const LEGACY_BRANCH_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
