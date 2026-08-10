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
  managedNativeServiceMatrix,
  managedStackContractFixtures,
  validateManagedStackContractFixtures,
} from "./managed-stack-contract.ts";
export { UnixHttpClient } from "./UnixHttpClient.ts";
