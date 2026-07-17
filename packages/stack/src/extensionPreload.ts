import { PRELOAD_REQUIRED_EXTENSIONS } from "./micro.ts";
import { installPodConfOverlay, readPreloadLibraries, writePreloadLibraries } from "./pgconf.ts";

export type ExtensionPreloadPlan =
  | { readonly action: "none" }
  | { readonly action: "update"; readonly libraries: ReadonlyArray<string> };

export const planExtensionPreload = (
  name: string,
  currentLibraries: ReadonlyArray<string>,
): ExtensionPreloadPlan => {
  if (!PRELOAD_REQUIRED_EXTENSIONS.has(name)) return { action: "none" };
  if (currentLibraries.includes(name)) return { action: "none" };
  return { action: "update", libraries: [...currentLibraries, name] };
};

export type ExtensionPreloadResult = "not-required" | "unchanged" | "updated";

/**
 * Idempotently persists the preload configuration required by an extension.
 * Process lifecycle remains the caller's responsibility: a running stack
 * restarts postgres after this function reports `updated`; a suspended pod
 * simply picks up the configuration on its next wake.
 */
export async function configureExtensionPreload(
  dataDir: string,
  name: string,
): Promise<ExtensionPreloadResult> {
  if (!PRELOAD_REQUIRED_EXTENSIONS.has(name)) return "not-required";
  await installPodConfOverlay(dataDir);
  const plan = planExtensionPreload(name, await readPreloadLibraries(dataDir));
  if (plan.action === "none") return "unchanged";
  await writePreloadLibraries(dataDir, plan.libraries);
  return "updated";
}
