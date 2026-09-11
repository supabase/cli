import { CAPABILITY_NAMES, type CapabilityName } from "../public/Capability.ts";
import type { StackConfig } from "../public/Config.ts";
import { CAPABILITY_MODULES } from "./ExecutionPlan.ts";

export type ExcludableCapabilityName = Exclude<CapabilityName, "database">;

/** Disable requested optional capabilities and their transitive dependents. */
export const excludeStackCapabilities = (
  config: StackConfig,
  exclusions: readonly ExcludableCapabilityName[],
): StackConfig => {
  if (exclusions.length === 0) return config;

  const disabled = new Set<CapabilityName>(exclusions);
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of CAPABILITY_NAMES) {
      if (name === "database" || disabled.has(name)) continue;
      if (CAPABILITY_MODULES[name].dependencies.some((dependency) => disabled.has(dependency))) {
        disabled.add(name);
        changed = true;
      }
    }
  }

  const capabilities = { ...config.capabilities };
  for (const name of CAPABILITY_NAMES) {
    if (name === "database" || !disabled.has(name)) continue;
    capabilities[name] = { enabled: false };
  }
  return { ...config, capabilities };
};
