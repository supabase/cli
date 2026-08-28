import {
  Crypto,
  Effect,
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
import { STACK_RPC_RELEASE } from "../control/StackRpc.ts";
import {
  StackOwnershipConflictError,
  StackStateInvalidError,
  StackUpgradeRequiredError,
} from "../public/Errors.ts";

export { StackRuntimeEnvironment } from "../state/Ownership.ts";
export type { StackRuntimeEnvironmentValue } from "../state/Ownership.ts";

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
    supervisorEntrypoint: fileURLToPath(
      new URL("../entrypoints/supervisor-node.ts", import.meta.url),
    ),
  };
};

const ReadySchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    stackId: StackIdSchema,
    ownerSessionId: Schema.String,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    code: Schema.Literals(["ownership-conflict", "failed"] as const),
    message: Schema.String,
  }),
]);
type ReadyMessage = Schema.Schema.Type<typeof ReadySchema>;
type ReadinessResult =
  | { readonly kind: "ready"; readonly stackId: StackId; readonly ownerSessionId: string }
  | { readonly kind: "ownership-conflict" }
  | { readonly kind: "failed"; readonly message: string };

type ChildResult =
  | { readonly kind: "ready"; readonly metadata: OwnerMetadata }
  | { readonly kind: "ownership-conflict" }
  | { readonly kind: "failed"; readonly message: string };

interface LaunchPayload {
  readonly stateRoot: string;
  readonly tempRoot: string;
  readonly platform: "posix" | "windows";
  readonly stackId: StackId;
  readonly ownerSessionId: string;
  readonly rpcRelease: string;
  readonly identity: StackIdentity;
}

const mapFailure = (message: string) => new StackStateInvalidError({ message });
const SUPERVISOR_READINESS_TIMEOUT_MS = 5_000;

export interface LauncherOptions {
  readonly identity: StackIdentity;
  readonly stackId: StackId;
  readonly stateStore: StackStateStore;
  readonly environment: StackRuntimeEnvironmentValue;
}

const encodeLaunchPayload = (
  payload: LaunchPayload,
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
  const classify = (value: ReadyMessage): Effect.Effect<ReadinessResult> =>
    value.ok
      ? Effect.succeed({
          kind: "ready",
          stackId: value.stackId,
          ownerSessionId: value.ownerSessionId,
        })
      : value.code === "ownership-conflict"
        ? Effect.succeed({ kind: "ownership-conflict" })
        : Effect.succeed({ kind: "failed", message: value.message });
  return Schema.decodeEffect(Schema.fromJsonString(ReadySchema))(text).pipe(
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
    if (metadata.rpcRelease !== STACK_RPC_RELEASE)
      return yield* new StackUpgradeRequiredError({
        message: `Stack owner release ${metadata.rpcRelease} requires explicit restart`,
        expectedRelease: STACK_RPC_RELEASE,
        actualRelease: metadata.rpcRelease,
      });
    const probe = yield* makeControlClient(metadata.endpoint, {
      stackId: options.stackId,
      ownerSessionId: metadata.ownerSessionId,
    })
      .probe()
      .pipe(Effect.mapError((error) => mapFailure(String(error))));
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
    // FileSystem.watch does not expose a subscription-ready signal. A short,
    // Schedule-driven reread closes the publication gap between the initial
    // absent read and watcher registration without ad-hoc timers. The outer
    // launch timeout remains the single five-second guard.
    const ownerFromReread = Stream.fromEffect(
      readOwnerMetadata(options.environment.stateRoot, options.stackId, options.environment),
    ).pipe(
      Stream.repeat(Schedule.spaced("25 millis").pipe(Schedule.upTo({ times: 200 }))),
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
  payload: LaunchPayload,
  paths: { readonly stackRoot: string },
): Effect.Effect<
  OwnerMetadata,
  StackOwnershipConflictError | StackStateInvalidError,
  FileSystem.FileSystem | Path.Path | Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const command = options.environment.supervisorCommand;
    const entrypoint = options.environment.supervisorEntrypoint;
    if (command === undefined || entrypoint === undefined)
      return yield* mapFailure("Supervisor launcher is not configured");
    const encoded = yield* encodeLaunchPayload(payload);
    // Subscribe before spawning: a loser can observe the winner's exact
    // metadata publication even when its own child exits on O_EXCL conflict.
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
      if (current !== undefined) return current;
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
      yield* validateCompatibleOwner(options, existing);
      return existing;
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
    const payload: LaunchPayload = {
      stateRoot: options.environment.stateRoot,
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
