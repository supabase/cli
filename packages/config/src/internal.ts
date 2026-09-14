/**
 * Not covered by semver: exists solely for `apps/cli`'s own use, and can change or vanish in
 * any release without notice. External consumers must use `.`, `./effect`, or `./io` instead.
 *
 * `loadCliConfig`/`resolveCliConfigValue`/`resolveCliConfigSubtree` below are the same runtime
 * functions `./effect` exports, re-typed here to widen their options parameter to the
 * internal-only `goViperCompat` knob.
 */
export { ENV_CAPTURE_REGEX } from "./lib/env.ts";
export {
  type AppliedConfigEdit,
  applyConfigEdits,
  type ConfigEdit,
  type ConfigEditOutcome,
  type ConfigEditRefusal,
  type ConfigEditRefusalReason,
  type ConfigEditValue,
} from "./config-edit.ts";
export { projectConfigApiBlockKeys } from "./project-config/api-attributes.ts";
export { dualScopeProjectConfigPaths } from "./project-config/project-config.ts";
export { AUTH_HOOK_NAMES, unmappedSecretApiPaths } from "./project-config/registry-auth.ts";
export { projectConfigMappingRows } from "./project-config/registry.ts";
export { type ProjectConfigMappingRow } from "./project-config/registry-row.ts";
export { type ProjectConfigApiAttributes } from "./project-config/api-attributes.ts";
export { type InternalLoadCliConfigOptions } from "./config-document.ts";
export { resolveCliConfigValue, resolveCliConfigSubtree } from "./project.ts";
export {
  loadCliConfig,
  remoteNameForProjectRef,
  remoteProjectIdEntries,
  writeCliConfigDocumentText,
  decodeCliConfigDocumentForValidationEffect,
  type DecodeCliConfigDocumentForValidationEffectOptions,
} from "./io.ts";
export { CliConfigWriteError } from "./errors.ts";
