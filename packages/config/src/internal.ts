/**
 * NOT covered by semver. This subpath exists solely for `apps/cli`'s own use
 * and its contract-guard tests — every export here (its existence, its shape,
 * its behavior) can change or vanish in any release without notice. External
 * consumers must use `.`, `./effect`, or `./io` instead; only `apps/cli` may
 * import `@supabase/config/internal` (enforced by
 * `src/monorepo-import-contract.unit.test.ts`).
 *
 * `loadCliConfig`/`resolveCliConfigValue`/`resolveCliConfigSubtree` below are
 * the SAME runtime functions `./effect` exports, just re-typed here to widen
 * their options parameter to the internal-only, Go-parity `goViperCompat`
 * knob (`InternalLoadCliConfigOptions`/`InternalResolveCliConfigOptions`) —
 * this module otherwise only re-exports types and registry data, not
 * independent implementations.
 */
export { ENV_CAPTURE_REGEX } from "./lib/env.ts";
export { AUTH_HOOK_NAMES, unmappedSecretApiPaths } from "./project-config/registry-auth.ts";
export { projectConfigMappingRows } from "./project-config/registry.ts";
export { type ProjectConfigMappingRow } from "./project-config/registry-row.ts";
export { type ProjectConfigApiAttributes } from "./project-config/api-attributes.ts";
export { type InternalLoadCliConfigOptions } from "./config-document.ts";
export { resolveCliConfigValue, resolveCliConfigSubtree } from "./project.ts";
export { loadCliConfig } from "./io.ts";
