import { createReadyStack, type StackHandle } from "./createStack.ts";
import { platformFactory } from "./node.ts";
import { provisionedStackConfig, type ProvisionedStackOptions } from "./provisionedStack.ts";

export async function createProvisionedStack(
  options: ProvisionedStackOptions,
): Promise<StackHandle> {
  return createReadyStack(provisionedStackConfig(options), platformFactory);
}

export type {
  ProvisionedServiceName,
  ProvisionedStackOptions,
  ProvisionedStackVersions,
} from "./provisionedStack.ts";
export { configureExtensionPreload } from "./extensionPreload.ts";
export type { ExtensionPreloadResult } from "./extensionPreload.ts";
