import { tmpdir } from "node:os";
import { NodeServices } from "@effect/platform-node";
import { Cause, Data, Effect, Exit, FileSystem, Option, Path } from "effect";
import { defaultRuntimeEnvironment, StackRuntimeEnvironment } from "../supervisor/Launcher.ts";
import {
  createStack as createEffectStack,
  type CreateStackOptions,
  type EffectStack,
} from "./EffectStack.ts";
import type { StackConfig } from "./Config.ts";
import type { StackStatus } from "./Status.ts";
import type { StackRuntimeEnvironmentValue } from "../state/Ownership.ts";
import { StackCleanupError } from "./Errors.ts";

export class TestStackReadinessError extends Data.TaggedError("TestStackReadinessError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class TestStackOperationError extends Data.TaggedError("TestStackOperationError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const call = <A, R>(
  operation: Effect.Effect<A, Error, R>,
): Effect.Effect<A, TestStackOperationError, R> =>
  operation.pipe(
    Effect.mapError((cause) => {
      const message =
        cause instanceof Error && cause.message.length > 0
          ? cause.message
          : typeof cause === "object" && cause !== null && "cause" in cause
            ? String(cause.cause)
            : String(cause);
      return new TestStackOperationError({ message, cause });
    }),
  );

export interface CreateTestStackOptions {
  readonly config?: StackConfig;
  readonly name?: string;
  readonly runtime?: CreateStackOptions["runtime"];
  /** Populates the isolated project root before the managed stack is created. */
  readonly setupProject?: (
    projectRoot: string,
  ) => Effect.Effect<void, Error, FileSystem.FileSystem | Path.Path>;
}

export type TestStack = EffectStack & {
  /** Managed state root shared with ordinary package and CLI stacks. */
  readonly stateRoot: string;
};

export interface TestStackOperations {
  readonly createRoot: Effect.Effect<string, Error>;
  readonly createStack: (
    options: CreateStackOptions,
    environment?: StackRuntimeEnvironmentValue,
  ) => Effect.Effect<EffectStack, Error>;
  readonly removeRoot: (root: string) => Effect.Effect<void, Error>;
}

export type TestStackError = TestStackOperationError | TestStackReadinessError;

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
  createRoot: createTestProjectRoot.pipe(Effect.provide(NodeServices.layer)),
  createStack: (options, environment) => {
    const stack = createEffectStack(options).pipe(Effect.provide(NodeServices.layer));
    return environment === undefined
      ? stack
      : stack.pipe(Effect.provideService(StackRuntimeEnvironment, environment));
  },
  removeRoot: (root) =>
    Effect.flatMap(FileSystem.FileSystem, (fs) =>
      fs.remove(root, { recursive: true, force: true }),
    ).pipe(Effect.provide(NodeServices.layer)),
};

const testRuntimeEnvironment = Effect.gen(function* () {
  const path = yield* Path.Path;
  const environment = yield* defaultRuntimeEnvironment;
  return {
    ...environment,
    artifactCacheRoot: path.join(tmpdir(), "supabase-stack-test-artifacts"),
  } satisfies StackRuntimeEnvironmentValue;
});

const validateStartedStatus = (
  initial: StackStatus,
  config: StackConfig | undefined,
): Effect.Effect<void, TestStackReadinessError> => {
  const disabledCapabilities = new Set(
    Object.entries(config?.capabilities ?? {}).flatMap(([name, capability]) =>
      capability !== undefined && "enabled" in capability && capability.enabled === false
        ? [name]
        : [],
    ),
  );
  const configuredListeners = Object.entries(config?.listeners ?? {}).flatMap(([name, listener]) =>
    listener === undefined || ("enabled" in listener && listener.enabled === false) ? [] : [name],
  );
  const ready =
    initial.lifecycle === "running" &&
    initial.capabilities.every(
      (capability) =>
        disabledCapabilities.has(capability.name) ||
        capability.state === "disabled" ||
        capability.state === "ready" ||
        capability.state === "dormant" ||
        (capability.state === "stopping" && capability.activation === "lazy"),
    ) &&
    configuredListeners.every((name) =>
      Object.entries(initial.endpoints).some(
        ([endpointName, endpoint]) => endpointName === name && endpoint !== undefined,
      ),
    );
  if (ready) return Effect.void;
  const failed = initial.capabilities.find(
    (capability) =>
      !disabledCapabilities.has(capability.name) &&
      (capability.state === "failed" ||
        (initial.lifecycle === "running" && capability.state === "stopped")),
  );
  return Effect.fail(
    failed === undefined
      ? new TestStackReadinessError({
          message: `Stack did not become ready after start (lifecycle ${initial.lifecycle})`,
        })
      : new TestStackReadinessError({
          message:
            failed.error === undefined
              ? `Capability ${failed.name} ${failed.state} before stack became ready`
              : failed.error,
        }),
  );
};

const cleanup = (
  stack: EffectStack | undefined,
  root: string,
  operations: TestStackOperations,
  primary?: TestStackOperationError | TestStackReadinessError,
) =>
  Effect.gen(function* () {
    if (stack !== undefined) {
      const failure = yield* call(stack.destroy()).pipe(
        Effect.match({ onSuccess: () => undefined, onFailure: (error) => error }),
      );
      if (failure !== undefined)
        return yield* new TestStackReadinessError({
          message: `${(primary ?? failure).message}; retained test stack root ${root}`,
          cause: primary ?? failure.cause,
        });
    }
    yield* call(operations.removeRoot(root));
  });

/** Creates an isolated managed Effect stack and owns its cleanup. */
export const createTestStackWith = (
  options: CreateTestStackOptions = {},
  operations: TestStackOperations | TestStackOperationsOverrides = defaultOperations,
): Effect.Effect<TestStack, TestStackError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const resolvedOperations = { ...defaultOperations, ...operations };
      const projectRoot = yield* restore(call(resolvedOperations.createRoot));
      let stack: EffectStack | undefined;
      const acquisition = Effect.gen(function* () {
        if (options.setupProject !== undefined) yield* call(options.setupProject(projectRoot));
        const runtimeEnvironment = yield* testRuntimeEnvironment;
        const resource = yield* call(
          resolvedOperations.createStack(
            {
              projectRoot,
              name: options.name,
              runtime: options.runtime,
              initialConfig: options.config ?? {},
            },
            runtimeEnvironment,
          ),
        );
        stack = resource;
        yield* call(resource.start()).pipe(
          Effect.flatMap((started) => validateStartedStatus(started, options.config)),
          Effect.catch((error) =>
            Effect.gen(function* () {
              const [snapshot, recentLogs] = yield* Effect.all(
                [
                  call(resource.status).pipe(Effect.catch(() => Effect.undefined)),
                  call(resource.logs({ tail: 50 })).pipe(Effect.catch(() => Effect.undefined)),
                ],
                { concurrency: 2 },
              );
              const capabilities =
                snapshot === undefined
                  ? "unavailable"
                  : snapshot.capabilities
                      .map(
                        ({ name, state, error: reason }) =>
                          `${name}=${state}${reason === undefined ? "" : ` (${reason})`}`,
                      )
                      .join(", ");
              const logs =
                recentLogs === undefined
                  ? "unavailable"
                  : recentLogs.entries
                      .slice(-50)
                      .map(({ source, stream, message }) => `${source}/${stream}: ${message}`)
                      .join("\n") || "none";
              return yield* new TestStackReadinessError({
                message: `${error.message}; lifecycle=${snapshot?.lifecycle ?? "unavailable"}; capabilities=${capabilities}; recent logs:\n${logs}`,
                cause: error,
              });
            }),
          ),
        );
        const removeOwnedRoot = resolvedOperations.removeRoot(projectRoot).pipe(
          Effect.mapError(
            (cause) =>
              new StackCleanupError({
                message: `Failed to remove test stack root ${projectRoot}`,
                cause,
              }),
          ),
        );
        const destroy = (selection?: Parameters<EffectStack["destroy"]>[0]) =>
          selection?.services === undefined
            ? resource.destroy(selection).pipe(Effect.andThen(removeOwnedRoot))
            : resource.destroy(selection);
        return {
          ...resource,
          destroy,
          stateRoot: runtimeEnvironment.stateRoot,
        } satisfies TestStack;
      });
      const acquired = yield* Effect.exit(restore(acquisition));
      if (Exit.isSuccess(acquired)) return acquired.value;
      const primary = Option.match(Cause.findErrorOption(acquired.cause), {
        onNone: () => undefined,
        onSome: (error) => error,
      });
      const released = yield* Effect.exit(cleanup(stack, projectRoot, resolvedOperations, primary));
      if (Exit.isFailure(released))
        return yield* Effect.failCause(Cause.combine(released.cause, acquired.cause));
      return yield* Effect.failCause(acquired.cause);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

/** Creates an isolated managed Effect stack and owns exactly that identity's cleanup. */
export const createTestStack = (options: CreateTestStackOptions = {}) =>
  createTestStackWith(options);
