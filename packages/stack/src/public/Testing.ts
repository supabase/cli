// oxlint-disable effecttsgo/async-function -- AsyncDisposable is the public test-resource contract.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- test resource owns its exact temp directory.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- test resource builds an isolated root.
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Data } from "effect";
import { defaultRuntimeEnvironment } from "../supervisor/Launcher.ts";
import {
  makePromiseApi,
  type PromiseStack,
  type PromiseStackConfig,
  type PromiseStartStackOptions,
} from "./PromiseStack.ts";
import type { CreateStackOptions } from "./EffectStack.ts";
import type { StackRuntimeEnvironmentValue } from "../state/Ownership.ts";

class TestStackReadinessError extends Data.TaggedError("TestStackReadinessError")<{
  readonly message: string;
}> {}
export interface CreateTestStackOptions {
  readonly config?: PromiseStackConfig;
  readonly name?: string;
  readonly runtime?: CreateStackOptions["runtime"];
  /**
   * Populates the isolated project root before the managed stack is created.
   * Setup failures remove the root and never create a stack handle.
   */
  readonly setupProject?: (projectRoot: string) => Promise<void>;
}

export type TestStack = PromiseStack &
  AsyncDisposable & {
    /** Ephemeral coordination state root shared by overlapping helpers in this process. */
    readonly stateRoot: string;
  };

export interface TestStackOperations {
  readonly createRoot: () => Promise<string>;
  readonly createStack: (
    options: CreateStackOptions,
    environment?: StackRuntimeEnvironmentValue,
  ) => Promise<PromiseStack>;
  readonly removeRoot: (root: string) => Promise<void>;
  /** Enables an ephemeral coordination root for the default and explicit real-stack operations. */
  readonly createStateRoot?: () => Promise<string>;
  readonly removeStateRoot?: (root: string) => Promise<void>;
}

const defaultOperations: TestStackOperations = {
  createRoot: () => mkdtemp(join(tmpdir(), "supabase-stack-test-")),
  createStack: (options, environment) =>
    makePromiseApi(NodeServices.layer, environment).createStack(options),
  removeRoot: (root) => rm(root, { recursive: true, force: true }),
  createStateRoot: () => mkdtemp(join(tmpdir(), "supabase-stack-test-state-")),
  removeStateRoot: (root) => rm(root, { recursive: true, force: true }),
};

interface StateRootLease {
  readonly root: string;
  references: number;
}

interface StateRootLeaseState {
  lease: StateRootLease | undefined;
  creating: Promise<StateRootLease> | undefined;
}

const stateRootLeases = new WeakMap<TestStackOperations, StateRootLeaseState>();

const leaseStateFor = (operations: TestStackOperations): StateRootLeaseState => {
  const existing = stateRootLeases.get(operations);
  if (existing !== undefined) return existing;
  const state: StateRootLeaseState = { lease: undefined, creating: undefined };
  stateRootLeases.set(operations, state);
  return state;
};

const acquireStateRoot = async (operations: TestStackOperations): Promise<string | undefined> => {
  if (operations.createStateRoot === undefined || operations.removeStateRoot === undefined)
    return undefined;
  const state = leaseStateFor(operations);
  if (state.lease !== undefined) {
    state.lease.references += 1;
    return state.lease.root;
  }
  if (state.creating === undefined) {
    state.creating = operations
      .createStateRoot()
      .then((root) => {
        const lease = { root, references: 0 } satisfies StateRootLease;
        state.lease = lease;
        return lease;
      })
      .finally(() => {
        state.creating = undefined;
      });
  }
  const lease = await state.creating;
  lease.references += 1;
  return lease.root;
};

const releaseStateRoot = async (operations: TestStackOperations, root: string): Promise<void> => {
  const state = stateRootLeases.get(operations);
  const lease = state?.lease;
  if (state === undefined || lease === undefined || lease.root !== root) return;
  lease.references -= 1;
  if (lease.references > 0) return;
  state.lease = undefined;
  const removeStateRoot = operations.removeStateRoot;
  if (removeStateRoot === undefined) return;
  try {
    await removeStateRoot(root);
  } catch (error) {
    throw new Error(`Unable to remove shared test state root ${root}`, { cause: error });
  }
};

// Native slim-services artifacts are immutable and expensive to download. Keep one
// shared cache for test stacks while each stack's state/data roots remain disposable.
const testArtifactCacheRoot = join(tmpdir(), "supabase-stack-test-artifacts");

const isolatedEnvironment = (
  projectRoot: string,
  stateRoot = join(projectRoot, ".supabase", "managed", "stacks"),
): StackRuntimeEnvironmentValue => ({
  ...defaultRuntimeEnvironment(),
  artifactCacheRoot: testArtifactCacheRoot,
  stateRoot,
});

const validateStartedStatus = (
  initial: Awaited<ReturnType<PromiseStack["status"]>>,
  config: PromiseStackConfig | undefined,
) => {
  const disabledCapabilities = new Set(
    Object.entries(config?.capabilities ?? {}).flatMap(([name, capability]) =>
      capability !== undefined && "enabled" in capability && capability.enabled === false
        ? [name]
        : [],
    ),
  );
  const configuredListeners = Object.entries(config?.listeners ?? {}).flatMap(
    ([name, listener]) => {
      if (listener === undefined || ("enabled" in listener && listener.enabled === false)) {
        return [];
      }
      return [name];
    },
  );
  const ready = (status: typeof initial) =>
    status.lifecycle === "running" &&
    status.capabilities.every(
      (capability) =>
        disabledCapabilities.has(capability.name) ||
        capability.state === "disabled" ||
        capability.state === "ready" ||
        capability.state === "dormant",
    ) &&
    configuredListeners.every((name) =>
      Object.entries(status.endpoints).some(
        ([endpointName, endpoint]) => endpointName === name && endpoint !== undefined,
      ),
    );
  const terminalFailure = (status: typeof initial): TestStackReadinessError | undefined => {
    const failed = status.capabilities.find(
      (capability) =>
        !disabledCapabilities.has(capability.name) &&
        (capability.state === "failed" ||
          (status.lifecycle === "running" && capability.state === "stopped")),
    );
    if (failed !== undefined) {
      return new TestStackReadinessError({
        message:
          failed.error === undefined
            ? `Capability ${failed.name} ${failed.state} before stack became ready`
            : failed.error,
      });
    }
    if (
      status.lifecycle === "stopped" ||
      status.lifecycle === "destroying" ||
      status.lifecycle === "unconfigured" ||
      status.lifecycle === "stopping"
    ) {
      return new TestStackReadinessError({
        message: `Stack lifecycle ${status.lifecycle} before stack became ready`,
      });
    }
    return undefined;
  };
  if (ready(initial)) return;
  const failure = terminalFailure(initial);
  throw (
    failure ??
    new TestStackReadinessError({
      message: `Stack did not become ready after start (lifecycle ${initial.lifecycle})`,
    })
  );
};

const cleanup = async (
  stack: PromiseStack | undefined,
  root: string,
  operations: TestStackOperations,
  stateRoot?: string,
  primary?: unknown,
) => {
  let failure = primary;
  let rootCanBeRemoved = true;
  if (stack !== undefined) {
    try {
      await stack.destroy();
    } catch (error) {
      rootCanBeRemoved = false;
      if (failure === undefined) failure = error;
    }
  }
  // Retain the exact root when destroy fails because durable/Docker state may remain recoverable.
  if (rootCanBeRemoved) {
    try {
      await operations.removeRoot(root);
    } catch (error) {
      if (failure === undefined) failure = error;
    }
  }
  if (rootCanBeRemoved && stateRoot !== undefined) {
    try {
      await releaseStateRoot(operations, stateRoot);
    } catch (error) {
      if (failure === undefined) failure = error;
    }
  }
  if (!rootCanBeRemoved) {
    const reason = failure instanceof Error ? failure.message : String(failure);
    throw new Error(`${reason}; retained test stack root ${root}`, { cause: failure });
  }
  if (failure !== undefined) throw failure;
};

/** Internal seam used by integration tests; the package testing barrel exports only createTestStack. */
export const createTestStackWith = async (
  options: CreateTestStackOptions = {},
  operations: TestStackOperations = defaultOperations,
): Promise<TestStack> => {
  const projectRoot = await operations.createRoot();
  let stack: PromiseStack | undefined;
  let stateRoot: string | undefined;
  try {
    if (options.setupProject !== undefined) await options.setupProject(projectRoot);
    stateRoot = await acquireStateRoot(operations);
    const runtimeEnvironment = isolatedEnvironment(projectRoot, stateRoot);
    stack = await operations.createStack(
      {
        projectRoot,
        name: options.name,
        runtime: options.runtime,
      },
      runtimeEnvironment,
    );
    const started = await stack.start(
      options.config === undefined
        ? undefined
        : ({ config: options.config } satisfies PromiseStartStackOptions),
    );
    try {
      validateStartedStatus(started, options.config);
    } catch (error) {
      if (error instanceof TestStackReadinessError) throw error;
      throw new TestStackReadinessError({ message: String(error) });
    }
    const resource = stack;
    return {
      ...resource,
      stateRoot: runtimeEnvironment.stateRoot,
      [Symbol.asyncDispose]: () => cleanup(resource, projectRoot, operations, stateRoot),
    };
  } catch (error) {
    await cleanup(stack, projectRoot, operations, stateRoot, error);
    throw error;
  }
};

/** Creates an isolated managed stack and destroys exactly that identity on disposal. */
export const createTestStack = (options: CreateTestStackOptions = {}): Promise<TestStack> =>
  createTestStackWith(options);
