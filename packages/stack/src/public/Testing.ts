import { tmpdir } from "node:os";
import { NodeServices } from "@effect/platform-node";
import { Cause, Data, Effect, Exit, FileSystem, Path } from "effect";
import { defaultRuntimeEnvironment } from "../supervisor/Launcher.ts";
import { makePromiseApi, type PromiseStack, type PromiseStackConfig } from "./PromiseStack.ts";
import type { CreateStackOptions } from "./EffectStack.ts";
import type { StackRuntimeEnvironmentValue } from "../state/Ownership.ts";

class TestStackReadinessError extends Data.TaggedError("TestStackReadinessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class TestStackOperationError extends Data.TaggedError("TestStackOperationError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const call = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      new TestStackOperationError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

const run = <A, E>(program: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromiseExit(program).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const error = Cause.squash(exit.cause);
    throw error instanceof TestStackOperationError ? error.cause : error;
  });
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

const createTestProjectRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectsRoot = path.join(
    path.dirname((yield* defaultRuntimeEnvironment).stateRoot),
    "test-projects",
  );
  yield* fs.makeDirectory(projectsRoot, { recursive: true });
  return yield* fs.makeTempDirectory({ directory: projectsRoot, prefix: "supabase-stack-test-" });
});

const defaultOperations: TestStackOperations = {
  createRoot: () => run(createTestProjectRoot.pipe(Effect.provide(NodeServices.layer))),
  createStack: (options, environment) =>
    makePromiseApi(NodeServices.layer, environment).createStack(options),
  removeRoot: (root) =>
    run(
      Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.remove(root, { recursive: true, force: true }),
      ).pipe(Effect.provide(NodeServices.layer)),
    ),
};

// Sharing immutable native artifacts keeps disposable test roots inexpensive.
const testRuntimeEnvironment = Effect.gen(function* () {
  const path = yield* Path.Path;
  return {
    ...(yield* defaultRuntimeEnvironment),
    artifactCacheRoot: path.join(tmpdir(), "supabase-stack-test-artifacts"),
  } satisfies StackRuntimeEnvironmentValue;
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
  if (ready(initial)) return Effect.void;
  const failure = terminalFailure(initial);
  return Effect.fail(
    failure ??
      new TestStackReadinessError({
        message: `Stack did not become ready after start (lifecycle ${initial.lifecycle})`,
      }),
  );
};

const STARTUP_DIAGNOSTIC_LOG_TAIL = 50;

const withStartupDiagnostics = (
  stack: PromiseStack,
  primary: TestStackOperationError | TestStackReadinessError,
) =>
  Effect.gen(function* () {
    const [snapshot, recentLogs] = yield* Effect.all(
      [
        call(() => stack.status()).pipe(Effect.catch(() => Effect.undefined)),
        call(() => stack.logs({ tail: STARTUP_DIAGNOSTIC_LOG_TAIL })).pipe(
          Effect.catch(() => Effect.undefined),
        ),
      ],
      { concurrency: 2 },
    );
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
    return new TestStackReadinessError({
      message: [
        primary.message,
        `lifecycle=${snapshot?.lifecycle ?? "unavailable"}`,
        `capabilities=${capabilityStates}`,
        `recent logs:\n${logs}`,
      ].join("; "),
      cause: primary instanceof TestStackOperationError ? primary.cause : primary,
    });
  });

const cleanup = (
  stack: PromiseStack | undefined,
  root: string,
  operations: TestStackOperations,
  primary?: TestStackOperationError | TestStackReadinessError,
) =>
  Effect.gen(function* () {
    if (stack !== undefined) {
      const failure = yield* call(() => stack.destroy()).pipe(
        Effect.match({
          onSuccess: () => undefined,
          onFailure: (error) => error,
        }),
      );
      // Failed destruction leaves the root available for recovery of durable state.
      if (failure !== undefined)
        return yield* new TestStackReadinessError({
          message: `${(primary ?? failure).message}; retained test stack root ${root}`,
          cause: primary ?? failure.cause,
        });
    }
    yield* call(() => operations.removeRoot(root)).pipe(
      Effect.mapError((error) => primary ?? error),
    );
    if (primary !== undefined) return yield* primary;
  });

/** Internal seam used by integration tests; the package testing barrel exports only createTestStack. */
export const createTestStackWith = (
  options: CreateTestStackOptions = {},
  operations: TestStackOperations | TestStackOperationsOverrides = defaultOperations,
): Promise<TestStack> =>
  run(
    Effect.gen(function* () {
      const resolvedOperations = { ...defaultOperations, ...operations };
      const projectRoot = yield* call(() => resolvedOperations.createRoot());
      let stack: PromiseStack | undefined;
      return yield* Effect.gen(function* () {
        if (options.setupProject !== undefined) {
          const setup = options.setupProject;
          yield* call(() => setup(projectRoot));
        }
        const runtimeEnvironment = yield* testRuntimeEnvironment;
        const resource = yield* call(() =>
          resolvedOperations.createStack(
            {
              projectRoot,
              name: options.name,
              runtime: options.runtime,
            },
            runtimeEnvironment,
          ),
        );
        stack = resource;
        yield* call(() =>
          resource.start(options.config === undefined ? undefined : { config: options.config }),
        ).pipe(
          Effect.flatMap((started) => validateStartedStatus(started, options.config)),
          Effect.catch((error) =>
            withStartupDiagnostics(resource, error).pipe(Effect.flatMap(Effect.fail)),
          ),
        );
        return {
          ...resource,
          stateRoot: runtimeEnvironment.stateRoot,
          [Symbol.asyncDispose]: () => run(cleanup(resource, projectRoot, resolvedOperations)),
        } satisfies TestStack;
      }).pipe(
        Effect.catch((error) =>
          cleanup(stack, projectRoot, resolvedOperations, error).pipe(
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

/** Creates an isolated managed stack and destroys exactly that identity on disposal. */
export const createTestStack = (options: CreateTestStackOptions = {}): Promise<TestStack> =>
  createTestStackWith(options);
