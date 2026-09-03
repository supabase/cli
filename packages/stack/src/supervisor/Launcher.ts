import {
  Cause,
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Option,
  Path,
  Result,
  Schedule,
  Scope,
  Schema,
  Stream,
} from "effect";
import { fileURLToPath } from "node:url";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { StackIdentity } from "../identity/Identity.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import { StackIdSchema, type StackId } from "../public/StackId.ts";
import {
  readOwnerMetadata,
  type OwnerMetadata,
  type StackRuntimeEnvironmentValue,
} from "../state/Ownership.ts";
import type { StackStateStore } from "../state/StackStateStore.ts";
import { makeControlClient } from "../control/ControlServer.ts";
import { isMaintenanceTransportFailure } from "../control/MaintenanceProtocol.ts";
import { STACK_RPC_RELEASE } from "../control/StackRpc.ts";
import {
  SupervisorReadySchema,
  type SupervisorReady,
  type SupervisorArgs,
} from "./LaunchProtocol.ts";
import {
  StackOwnershipConflictError,
  StackStateInvalidError,
  StackUpgradeRequiredError,
} from "../public/Errors.ts";

export { StackRuntimeEnvironment } from "../state/Ownership.ts";
export type { StackRuntimeEnvironmentValue } from "../state/Ownership.ts";

/** Private argv marker used when a compiled CLI dispatches its embedded Supervisor. */
export const SUPERVISOR_DISPATCH_SENTINEL = "__supabase_stack_supervisor__" as const;

export const supervisorEntrypointFor = (moduleUrl: string): string => {
  const sourceEntrypoint = fileURLToPath(new URL("../entrypoints/supervisor-node.ts", moduleUrl));
  return sourceEntrypoint.includes("/$bunfs/") ? SUPERVISOR_DISPATCH_SENTINEL : sourceEntrypoint;
};

/** Default host values are resolved only at the process composition boundary. */
export const defaultRuntimeEnvironment = (): StackRuntimeEnvironmentValue => {
  // This synchronous helper is the composition boundary where host environment
  // variables are read. The runtime itself receives a fully materialized value.
  // oxlint-disable-next-line effecttsgo/process-env -- composition-boundary environment read
  const home = process.env.SUPABASE_HOME ?? `${process.env.HOME ?? process.cwd()}/.supabase`;
  return {
    stateRoot: `${home}/managed/stacks`,
    // Keep the POSIX socket root short enough for AF_UNIX path limits.
    // oxlint-disable-next-line effecttsgo/process-env -- composition-boundary environment read
    tempRoot: process.platform === "win32" ? (process.env.TEMP ?? "C:\\Windows\\Temp") : "/tmp",
    platform: process.platform === "win32" ? "windows" : "posix",
    supervisorCommand: process.execPath,
    supervisorEntrypoint: supervisorEntrypointFor(import.meta.url),
  };
};

type ReadinessResult =
  | { readonly kind: "ready"; readonly stackId: StackId; readonly ownerSessionId: string }
  | { readonly kind: "ownership-conflict" }
  | { readonly kind: "failed"; readonly message: string };

type ChildResult =
  | { readonly kind: "ready"; readonly metadata: OwnerMetadata }
  | { readonly kind: "ownership-conflict" }
  | { readonly kind: "failed"; readonly message: string };

const mapFailure = (message: string) => new StackStateInvalidError({ message });
const SUPERVISOR_READINESS_TIMEOUT_MS = 30_000;
const SUPERVISOR_REREAD_INTERVAL_MS = 25;
const SUPERVISOR_READINESS_REREAD_TIMES = Math.floor(
  SUPERVISOR_READINESS_TIMEOUT_MS / SUPERVISOR_REREAD_INTERVAL_MS,
);

export interface LauncherOptions {
  readonly identity: StackIdentity;
  readonly stackId: StackId;
  readonly stateStore: StackStateStore;
  readonly environment: StackRuntimeEnvironmentValue;
}

const encodeLaunchPayload = (
  payload: SupervisorArgs,
): Effect.Effect<string, StackStateInvalidError> =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(payload).pipe(
    Effect.mapError(() => mapFailure("Unable to encode supervisor launch arguments")),
  );

const decodeReady = (bytes: Uint8Array): Effect.Effect<ReadinessResult, StackStateInvalidError> => {
  if (bytes.byteLength > 4096)
    return Effect.fail(mapFailure("Supervisor readiness frame exceeds size limit"));
  const text = new TextDecoder().decode(bytes);
  if (text.trim().length === 0)
    return Effect.succeed({ kind: "failed", message: "Supervisor exited before readiness" });
  const classify = (value: SupervisorReady): Effect.Effect<ReadinessResult> =>
    value.ok
      ? Effect.succeed({
          kind: "ready",
          stackId: value.stackId,
          ownerSessionId: value.ownerSessionId,
        })
      : value.code === "ownership-conflict"
        ? Effect.succeed({ kind: "ownership-conflict" })
        : Effect.succeed({ kind: "failed", message: value.message });
  return Schema.decodeEffect(Schema.fromJsonString(SupervisorReadySchema))(text).pipe(
    Effect.mapError(() => mapFailure("Invalid supervisor readiness frame")),
    Effect.flatMap(classify),
  );
};

const validateReady = (
  ready: { readonly kind: "ready"; readonly stackId: StackId; readonly ownerSessionId: string },
  options: LauncherOptions,
  expectedOwnerSessionId: string,
): Effect.Effect<void, StackStateInvalidError> =>
  ready.stackId === options.stackId && ready.ownerSessionId === expectedOwnerSessionId
    ? Effect.void
    : Effect.fail(mapFailure("Supervisor readiness identity mismatch"));

const validateCompatibleOwner = (
  options: LauncherOptions,
  metadata: OwnerMetadata,
): Effect.Effect<
  void,
  StackOwnershipConflictError | StackStateInvalidError | StackUpgradeRequiredError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const probeExit = yield* makeControlClient(metadata.endpoint, {
      stackId: options.stackId,
      ownerSessionId: metadata.ownerSessionId,
    })
      .probe()
      .pipe(Effect.exit);
    if (Exit.isFailure(probeExit)) {
      const failure = Cause.findErrorOption(probeExit.cause);
      if (Option.isSome(failure) && isMaintenanceTransportFailure(failure.value))
        return yield* mapFailure("Unable to probe existing Supervisor: transport unavailable");
      return yield* new StackOwnershipConflictError({
        message: "Existing Supervisor probe failed",
        stackId: options.stackId,
      });
    }
    const probe = probeExit.value;
    if (
      probe.ok &&
      probe.op === "probe" &&
      (metadata.rpcRelease !== STACK_RPC_RELEASE || probe.rpcRelease !== STACK_RPC_RELEASE)
    )
      return yield* new StackUpgradeRequiredError({
        message: `Stack owner release ${probe.rpcRelease} requires stop before start`,
        expectedRelease: STACK_RPC_RELEASE,
        actualRelease: probe.rpcRelease,
      });
    if (
      !probe.ok ||
      probe.op !== "probe" ||
      probe.stackId !== options.stackId ||
      probe.ownerSessionId !== metadata.ownerSessionId
    )
      return yield* new StackOwnershipConflictError({
        message: "Existing Supervisor failed session probe",
        stackId: options.stackId,
      });
  });

const observeOwner = (
  options: LauncherOptions,
  paths: { readonly stackRoot: string },
): Effect.Effect<OwnerMetadata, StackStateInvalidError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const ownerFromEvents = Stream.filterMapEffect(fs.watch(paths.stackRoot), () =>
      readOwnerMetadata(options.environment.stateRoot, options.stackId, options.environment).pipe(
        Effect.map((metadata) =>
          metadata === undefined ? Result.fail(undefined) : Result.succeed(metadata),
        ),
      ),
    );
    // FileSystem.watch does not expose a subscription-ready signal. A bounded,
    // Schedule-driven reread closes the publication gap between the initial absent
    // read and watcher registration across the same budget as the launch guard.
    const ownerFromReread = Stream.fromEffect(
      readOwnerMetadata(options.environment.stateRoot, options.stackId, options.environment),
    ).pipe(
      Stream.repeat(
        Schedule.spaced(`${SUPERVISOR_REREAD_INTERVAL_MS} millis`).pipe(
          Schedule.upTo({ times: SUPERVISOR_READINESS_REREAD_TIMES }),
        ),
      ),
      Stream.filterMap((metadata) =>
        metadata === undefined ? Result.fail(undefined) : Result.succeed(metadata),
      ),
    );
    const observed = yield* Stream.runHead(Stream.merge(ownerFromEvents, ownerFromReread)).pipe(
      Effect.mapError((error) => mapFailure(String(error))),
    );
    if (Option.isNone(observed))
      return yield* mapFailure("Supervisor owner metadata was not published");
    return observed.value;
  });

const launchAndAwait = (
  options: LauncherOptions,
  payload: SupervisorArgs,
  paths: { readonly stackRoot: string },
): Effect.Effect<
  OwnerMetadata,
  StackOwnershipConflictError | StackStateInvalidError | StackUpgradeRequiredError,
  FileSystem.FileSystem | Path.Path | Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const command = options.environment.supervisorCommand;
    const entrypoint = options.environment.supervisorEntrypoint;
    if (command === undefined || entrypoint === undefined)
      return yield* mapFailure("Supervisor launcher is not configured");
    const encoded = yield* encodeLaunchPayload(payload);
    // Subscribe before spawning: a loser can observe the winner's exact
    // metadata publication even when its own child loses the atomic lock race.
    const ownerFiber = yield* Effect.forkChild(observeOwner(options, paths), {
      startImmediately: true,
    });
    const child = yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const child = yield* restore(
          ChildProcess.make(command, [entrypoint, encoded], {
            detached: true,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            additionalFds: { fd3: { type: "output" } },
          }),
        );
        yield* Effect.asVoid(child.unref);
        return child;
      }),
    );
    const readiness: Effect.Effect<
      ChildResult,
      StackStateInvalidError,
      FileSystem.FileSystem | Path.Path
    > = Effect.gen(function* () {
      const chunks = yield* Stream.runCollect(child.getOutputFd(3));
      const values = chunks;
      const length = values.reduce((sum, value) => sum + value.byteLength, 0);
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const value of values) {
        bytes.set(value, offset);
        offset += value.byteLength;
      }
      const ready = yield* decodeReady(bytes);
      if (ready.kind !== "ready") return ready;
      yield* validateReady(ready, options, payload.ownerSessionId);
      const metadata = yield* readOwnerMetadata(
        options.environment.stateRoot,
        options.stackId,
        options.environment,
      );
      if (metadata === undefined)
        return yield* mapFailure("Supervisor readiness arrived before owner metadata");
      if (
        metadata.ownerSessionId !== ready.ownerSessionId ||
        metadata.rpcRelease !== payload.rpcRelease
      )
        return yield* mapFailure("Supervisor readiness metadata identity mismatch");
      return { kind: "ready", metadata } satisfies ChildResult;
    }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(mapFailure(error.message))));
    const terminateLaunch: Effect.Effect<void> = Effect.all([
      Effect.ignore(child.kill()),
      Fiber.interrupt(ownerFiber),
    ]).pipe(Effect.asVoid);
    const childResult = yield* readiness.pipe(
      Effect.timeoutOrElse({
        duration: SUPERVISOR_READINESS_TIMEOUT_MS,
        orElse: () => Effect.fail(mapFailure("Supervisor did not publish readiness in time")),
      }),
      Effect.tapError(() => terminateLaunch),
      Effect.onInterrupt(() => terminateLaunch),
    );
    if (childResult.kind === "ownership-conflict") {
      const current = yield* readOwnerMetadata(
        options.environment.stateRoot,
        options.stackId,
        options.environment,
      );
      if (current !== undefined) {
        // The watcher is only a launch-time helper once the winner is visible.
        yield* Fiber.interrupt(ownerFiber);
        return yield* validateCompatibleOwner(options, current).pipe(
          Effect.as(current),
          Effect.catchTag("StackStateInvalidError", () =>
            Effect.fail(
              new StackOwnershipConflictError({
                message: "A live Supervisor owns this stack but is not responding",
                stackId: options.stackId,
              }),
            ),
          ),
        );
      }
      return yield* Fiber.join(ownerFiber).pipe(
        Effect.timeoutOrElse({
          duration: 5_000,
          orElse: () =>
            Fiber.interrupt(ownerFiber).pipe(
              Effect.andThen(
                Effect.fail(
                  new StackOwnershipConflictError({
                    message: "Supervisor ownership conflict did not publish a compatible owner",
                    stackId: options.stackId,
                  }),
                ),
              ),
            ),
        }),
      );
    }
    yield* Fiber.interrupt(ownerFiber);
    if (childResult.kind === "failed") {
      yield* terminateLaunch;
      return yield* mapFailure(childResult.message);
    }
    return childResult.metadata;
  }).pipe(Effect.catchTag("PlatformError", (error) => Effect.fail(mapFailure(error.message))));

/**
 * Starts one detached owner process or joins the owner concurrently published
 * by another caller. The lock itself is acquired in the supervisor process.
 */
export const ensureSupervisor = (
  options: LauncherOptions,
): Effect.Effect<
  OwnerMetadata,
  StackOwnershipConflictError | StackStateInvalidError | StackUpgradeRequiredError,
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | Scope.Scope
  | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const existing = yield* readOwnerMetadata(
      options.environment.stateRoot,
      options.stackId,
      options.environment,
    );
    if (existing !== undefined) {
      const compatible = yield* validateCompatibleOwner(options, existing).pipe(
        Effect.as(true),
        // A published document with an unavailable control endpoint may be a
        // crashed owner. Let the child arbitrate through the OS-held lease;
        // malformed metadata remains fail-closed in readOwnerMetadata.
        Effect.catchTag("StackStateInvalidError", () => Effect.succeed(false)),
      );
      if (compatible) return existing;
    }
    const stackId = yield* Schema.decodeEffect(StackIdSchema)(options.stackId).pipe(
      Effect.mapError((error) => mapFailure(`Invalid StackId: ${String(error)}`)),
    );
    const paths = yield* resolveStackPaths({
      stateRoot: options.environment.stateRoot,
      stackId,
    }).pipe(Effect.mapError((error) => mapFailure(String(error))));
    const crypto = yield* Crypto.Crypto;
    const ownerSessionId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((error) =>
        mapFailure(`Unable to allocate owner session id: ${error.message}`),
      ),
    );
    const payload: SupervisorArgs = {
      stateRoot: options.environment.stateRoot,
      ...(options.environment.artifactCacheRoot === undefined
        ? {}
        : { artifactCacheRoot: options.environment.artifactCacheRoot }),
      tempRoot: options.environment.tempRoot,
      platform: options.environment.platform,
      stackId: options.stackId,
      ownerSessionId,
      rpcRelease: STACK_RPC_RELEASE,
      identity: options.identity,
    };
    yield* (yield* FileSystem.FileSystem)
      .makeDirectory(paths.runtime, { recursive: true })
      .pipe(
        Effect.mapError((error) =>
          mapFailure(`Unable to prepare owner runtime directory: ${error.message}`),
        ),
      );
    const owner = yield* launchAndAwait(options, payload, { stackRoot: paths.stackRoot });
    yield* validateCompatibleOwner(options, owner);
    return owner;
  });
