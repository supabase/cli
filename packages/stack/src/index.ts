import { Effect, Option } from "effect";
import * as StackEffect from "./effect.ts";
import { acquire, runOnce, stackAdapter, type CallOptions, type Client } from "./PromiseClient.ts";

export type {
  CallOptions,
  DatabaseInstance,
  ServiceCreationInput,
  ServiceInstance,
  ServiceInstances,
  Stack,
  ToolOptions,
} from "./PromiseClient.ts";
export type { StackCredentials, StackKeysInput } from "./State.ts";
export { postgres } from "./Tools.ts";
export { StackError } from "./Rpc.ts";
export type { CompositionConfig } from "./Orchestrator.ts";
export type { Observation } from "./Rpc.ts";
export type {
  CreateOptions,
  CreationChange,
  DatabaseSnapshotOptions,
  DestroyResult,
  FindOptions,
  FoundStack,
  OpenOptions,
  PgProveOptions,
  PlannedInstance,
  SavedStack,
  StackLocations,
  SupabaseCompositionOptions,
} from "./effect.ts";

const adaptStack = (acquired: { readonly value: StackEffect.Stack; readonly client: Client }) =>
  stackAdapter(acquired.client).stack(acquired.value);

/** Registers a new stack identity. */
export const create = (options: StackEffect.CreateOptions, callOptions?: CallOptions) =>
  acquire(StackEffect.create(options), callOptions).then(adaptStack);
/** Opens an existing stack without launching its services. */
export const open = (options: StackEffect.OpenOptions, callOptions?: CallOptions) =>
  acquire(StackEffect.open(options), callOptions).then(adaptStack);
/** Discovers readable saved stacks with their live owners; `onInvalidState` observes skipped entries. */
export const discover = (
  options: Pick<StackEffect.StackLocations, "stateRoot"> & {
    readonly onInvalidState?: (id: string, error: Error) => void;
  },
  callOptions?: CallOptions,
) => {
  const onInvalidState = options.onInvalidState;
  return runOnce(
    StackEffect.discover({
      stateRoot: options.stateRoot,
      ...(onInvalidState === undefined
        ? {}
        : { onInvalidState: (id, error) => Effect.sync(() => onInvalidState(id, error)) }),
    }),
    callOptions,
  );
};
/** Reads one saved stack by id or by project identity; resolves `undefined` when none is saved. */
export const find = (options: StackEffect.FindOptions, callOptions?: CallOptions) =>
  runOnce(StackEffect.find(options).pipe(Effect.map(Option.getOrUndefined)), callOptions);
