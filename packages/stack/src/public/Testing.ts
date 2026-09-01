// oxlint-disable effecttsgo/async-function -- AsyncDisposable is the public test-resource contract.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- test resource owns its exact temp directory.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- test resource builds an isolated root.
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { defaultRuntimeEnvironment } from "../supervisor/Launcher.ts";
import {
  makePromiseApi,
  type PromiseStack,
  type PromiseStackConfig,
  type PromiseStartStackOptions,
} from "./PromiseStack.ts";
import type { CreateStackOptions } from "./EffectStack.ts";
import type { StackRuntimeEnvironmentValue } from "../state/Ownership.ts";

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

export type TestStack = PromiseStack & AsyncDisposable;

export interface TestStackOperations {
  readonly createRoot: () => Promise<string>;
  readonly createStack: (
    options: CreateStackOptions,
    environment?: StackRuntimeEnvironmentValue,
  ) => Promise<PromiseStack>;
  readonly removeRoot: (root: string) => Promise<void>;
}

const defaultOperations: TestStackOperations = {
  createRoot: () => mkdtemp(join(tmpdir(), "supabase-stack-test-")),
  createStack: (options, environment) =>
    makePromiseApi(NodeServices.layer, environment).createStack(options),
  removeRoot: (root) => rm(root, { recursive: true, force: true }),
};

// Native slim-services artifacts are immutable and expensive to download. Keep one
// shared cache for test stacks while each stack's state/data roots remain disposable.
const testArtifactCacheRoot = join(tmpdir(), "supabase-stack-test-artifacts");

const isolatedEnvironment = (projectRoot: string): StackRuntimeEnvironmentValue => ({
  ...defaultRuntimeEnvironment(),
  artifactCacheRoot: testArtifactCacheRoot,
  stateRoot: join(projectRoot, ".supabase", "managed", "stacks"),
});

const waitForReadiness = async (
  stack: PromiseStack,
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
  const terminalFailure = (status: typeof initial): Error | undefined => {
    const failed = status.capabilities.find(
      (capability) =>
        !disabledCapabilities.has(capability.name) &&
        (capability.state === "failed" ||
          (status.lifecycle === "running" && capability.state === "stopped")),
    );
    if (failed !== undefined) {
      return new Error(
        failed.error === undefined
          ? `Capability ${failed.name} ${failed.state} before stack became ready`
          : failed.error,
      );
    }
    if (
      status.lifecycle === "stopped" ||
      status.lifecycle === "destroying" ||
      status.lifecycle === "unconfigured" ||
      status.lifecycle === "stopping"
    ) {
      return new Error(`Stack lifecycle ${status.lifecycle} before stack became ready`);
    }
    return undefined;
  };
  if (ready(initial)) return;
  const initialFailure = terminalFailure(initial);
  if (initialFailure !== undefined) throw initialFailure;
  for await (const status of stack.watchStatus()) {
    if (ready(status)) return;
    const failure = terminalFailure(status);
    if (failure !== undefined) throw failure;
  }
  throw new Error("Stack did not reach running readiness before its status stream ended");
};

const cleanup = async (
  stack: PromiseStack | undefined,
  root: string,
  operations: TestStackOperations,
  primary?: unknown,
) => {
  let failure = primary;
  if (stack !== undefined) {
    try {
      await stack.destroy();
    } catch (error) {
      if (failure === undefined) failure = error;
    }
    try {
      await stack.close();
    } catch (error) {
      if (failure === undefined) failure = error;
    }
  }
  try {
    await operations.removeRoot(root);
  } catch (error) {
    if (failure === undefined) failure = error;
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
  try {
    if (options.setupProject !== undefined) await options.setupProject(projectRoot);
    stack = await operations.createStack(
      {
        projectRoot,
        name: options.name,
        runtime: options.runtime,
      },
      isolatedEnvironment(projectRoot),
    );
    const started = await stack.start(
      options.config === undefined
        ? undefined
        : ({ config: options.config } satisfies PromiseStartStackOptions),
    );
    await waitForReadiness(stack, started, options.config);
    const resource = stack;
    return {
      ...resource,
      [Symbol.asyncDispose]: () => cleanup(resource, projectRoot, operations),
    };
  } catch (error) {
    await cleanup(stack, projectRoot, operations, error);
    throw error;
  }
};

/** Creates an isolated managed stack and destroys exactly that identity on disposal. */
export const createTestStack = (options: CreateTestStackOptions = {}): Promise<TestStack> =>
  createTestStackWith(options);
