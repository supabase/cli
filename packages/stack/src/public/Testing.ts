// oxlint-disable effecttsgo/async-function -- AsyncDisposable is the public test-resource contract.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- test resource owns its exact temp directory.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- test resource builds an isolated root.
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Data, Effect, Schedule } from "effect";
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
class RetryReadiness extends Data.TaggedError("RetryReadiness")<{
  readonly message: string;
  readonly terminal?: boolean;
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
  signal?: AbortSignal,
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
  const initialFailure = terminalFailure(initial);
  if (initialFailure !== undefined) throw initialFailure;
  const poll = Effect.tryPromise({
    try: () => {
      signal?.throwIfAborted();
      return stack.status();
    },
    catch: (cause) =>
      new TestStackReadinessError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  }).pipe(
    Effect.flatMap(
      (next): Effect.Effect<Awaited<ReturnType<PromiseStack["status"]>>, RetryReadiness> => {
        if (ready(next)) return Effect.succeed(next);
        const failure = terminalFailure(next);
        return Effect.fail(
          new RetryReadiness({
            message: failure?.message ?? "Stack is not ready yet",
            ...(failure === undefined ? {} : { terminal: true }),
          }),
        );
      },
    ),
    Effect.retry({
      schedule: Schedule.spaced("100 millis").pipe(Schedule.upTo({ duration: "120 seconds" })),
      while: (error) => error instanceof RetryReadiness && error.terminal !== true,
    }),
  );
  try {
    await Effect.runPromise(poll);
  } catch (error) {
    if (error instanceof RetryReadiness)
      throw new TestStackReadinessError({ message: error.message });
    throw error;
  }
};

const cleanup = async (
  stack: PromiseStack | undefined,
  root: string,
  operations: TestStackOperations,
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
    const readyStack = stack;
    try {
      await waitForReadiness(readyStack, started, options.config, AbortSignal.timeout(120_000));
    } catch (error) {
      if (error instanceof TestStackReadinessError) throw error;
      throw new TestStackReadinessError({ message: String(error) });
    }
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
