import { PRELOAD_REQUIRED_EXTENSIONS } from "./micro.ts";

export type EnableExtensionPlan =
  | { readonly action: "none" }
  | { readonly action: "restart"; readonly libraries: ReadonlyArray<string> };

export const planEnableExtension = (
  name: string,
  currentLibraries: ReadonlyArray<string>,
): EnableExtensionPlan => {
  if (!PRELOAD_REQUIRED_EXTENSIONS.has(name)) return { action: "none" };
  if (currentLibraries.includes(name)) return { action: "none" };
  return { action: "restart", libraries: [...currentLibraries, name] };
};
