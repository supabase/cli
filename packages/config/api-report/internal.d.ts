/**
 * NOT covered by semver. This subpath exists solely for `apps/cli`'s own use
 * and its contract-guard tests — every export here (its existence, its shape,
 * its behavior) can change or vanish in any release without notice. External
 * consumers must use `.`, `./effect`, or `./io` instead.
 */
export { ENV_CAPTURE_REGEX } from "./lib/env.ts";
export { AUTH_HOOK_NAMES, unmappedSecretApiPaths } from "./project-config/registry-auth.ts";
export { projectConfigMappingRows } from "./project-config/registry.ts";
export { type ProjectConfigMappingRow } from "./project-config/registry-row.ts";
export { type ProjectConfigApiAttributes } from "./project-config/api-attributes.ts";
export { type InternalLoadCliConfigOptions } from "./config-document.ts";
export { type InternalResolveCliConfigOptions, resolveCliConfigValue, resolveCliConfigSubtree, } from "./project.ts";
export { loadCliConfig, loadCliConfigFile } from "./io.ts";
