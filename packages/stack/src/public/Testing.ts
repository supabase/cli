// oxlint-disable effecttsgo/async-function -- AsyncDisposable is the public test-resource contract.
// oxlint-disable-next-line effecttsgo/node-builtin-import -- test resource owns its exact temp directory.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- test resource builds an isolated root.
import { dirname, join } from "node:path";
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
    /** Managed state root shared with ordinary package and CLI stacks. */
    readonly stateRoot: string;
  };

export interface TestStackOperations {
  readonly createRoot: () => Promise<string>;
  readonly createStack: (
    options: CreateStackOptions,
    environment?: StackRuntimeEnvironmentValue,
  ) => Promise<PromiseStack>;
  readonly removeRoot: (root: string) => Promise<void>;
}

type TestStackOperationsOverrides = Partial<TestStackOperations>;

const createTestProjectRoot = async (): Promise<string> => {
  const projectsRoot = join(dirname(defaultRuntimeEnvironment().stateRoot), "test-projects");
  await mkdir(projectsRoot, { recursive: true });
  return mkdtemp(join(projectsRoot, "supabase-stack-test-"));
};

const defaultOperations: TestStackOperations = {
  createRoot: createTestProjectRoot,
  createStack: (options, environment) =>
    makePromiseApi(NodeServices.layer, environment).createStack(options),
  removeRoot: (root) => rm(root, { recursive: true, force: true }),
};

// Native slim-services artifacts are immutable and expensive to download. Keep one
// shared cache for test stacks while each stack's state/data roots remain disposable.
const testArtifactCacheRoot = join(tmpdir(), "supabase-stack-test-artifacts");

const testRuntimeEnvironment = (): StackRuntimeEnvironmentValue => ({
  ...defaultRuntimeEnvironment(),
  artifactCacheRoot: testArtifactCacheRoot,
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

const STARTUP_DIAGNOSTIC_LOG_TAIL = 50;

const withStartupDiagnostics = async (stack: PromiseStack, primary: unknown): Promise<Error> => {
  const [snapshot, recentLogs] = await Promise.all([
    stack.status().catch(() => undefined),
    stack.logs({ tail: STARTUP_DIAGNOSTIC_LOG_TAIL }).catch(() => undefined),
  ]);
  const capabilityStates =
    snapshot === undefined
      ? "unavailable"
      : snapshot.capabilities
          .map(
            ({ name, state, error }) =>
              `${name}=${state}${error === undefined ? "" : ` (${error})`}`,
          )
          .join(", ");
  const logs =
    recentLogs === undefined
      ? "unavailable"
      : recentLogs.entries
          .slice(-STARTUP_DIAGNOSTIC_LOG_TAIL)
          .map(({ source, stream, message }) => `${source}/${stream}: ${message}`)
          .join("\n") || "none";
  const reason = primary instanceof Error ? primary.message : String(primary);
  return new Error(
    [
      reason,
      `lifecycle=${snapshot?.lifecycle ?? "unavailable"}`,
      `capabilities=${capabilityStates}`,
      `recent logs:\n${logs}`,
    ].join("; "),
    { cause: primary },
  );
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
  operations: TestStackOperations | TestStackOperationsOverrides = defaultOperations,
): Promise<TestStack> => {
  const resolvedOperations: TestStackOperations = { ...defaultOperations, ...operations };
  const projectRoot = await resolvedOperations.createRoot();
  let stack: PromiseStack | undefined;
  try {
    if (options.setupProject !== undefined) await options.setupProject(projectRoot);
    const runtimeEnvironment = testRuntimeEnvironment();
    stack = await resolvedOperations.createStack(
      {
        projectRoot,
        name: options.name,
        runtime: options.runtime,
      },
      runtimeEnvironment,
    );
    try {
      const started = await stack.start(
        options.config === undefined
          ? undefined
          : ({ config: options.config } satisfies PromiseStartStackOptions),
      );
      validateStartedStatus(started, options.config);
    } catch (error) {
      throw await withStartupDiagnostics(stack, error);
    }
    const resource = stack;
    return {
      ...resource,
      stateRoot: runtimeEnvironment.stateRoot,
      [Symbol.asyncDispose]: () => cleanup(resource, projectRoot, resolvedOperations),
    };
  } catch (error) {
    await cleanup(stack, projectRoot, resolvedOperations, error);
    throw error;
  }
};

/** Creates an isolated managed stack and destroys exactly that identity on disposal. */
export const createTestStack = (options: CreateTestStackOptions = {}): Promise<TestStack> =>
  createTestStackWith(options);
