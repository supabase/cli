/** Test-only service tags for building deterministic consumer layers. */
export { DaemonServer } from "./DaemonServer.ts";
export type {
  ManagedStackContractArea,
  ManagedStackContractAction,
  ManagedStackContractEffects,
  ManagedStackContractExpectation,
  ManagedStackContractFact,
  ManagedStackContractJson,
  ManagedStackContractOutput,
  ManagedStackContractScenario,
  ManagedNativeServiceMatrix,
} from "./managed-stack-contract.ts";
export {
  managedNativePlatformByNodeTarget,
  managedNativePlatformFromNode,
  managedNativeServiceMatrix,
  managedStackContractFixtures,
} from "./managed-stack-contract.ts";
export { validateManagedStackContractFixtures } from "./managed-stack-contract-validation.ts";
export { UnixHttpClient } from "./UnixHttpClient.ts";
