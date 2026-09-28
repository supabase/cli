import { NodeStream } from "@effect/platform-node";
import {
  Crypto,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Effect ChildProcess cannot hand the owner a log file descriptor or release its lifeline pipe from the event loop.
import { spawn, type ChildProcess } from "node:child_process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- the spawner shares its owner log descriptor with the owner and reads the log tail through it.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { HOST_PROCESS_DISPATCH_SENTINEL, isBunVirtualPath } from "./internal/dispatch-markers.ts";
import { failureMessage } from "./internal/failure-message.ts";
import { stackSourceDigest } from "./internal/release.ts";
import { StackRpc } from "./Rpc.ts";
import { SavedStack, type Interface as StateInterface, type StateError } from "./State.ts";

declare const SUPABASE_STACK_BUILD_ID: string | undefined;

/**
 * A compiled CLI embeds the digest of the stack sources it was built from; a source checkout
 * computes it, so both agree for the same sources and any change to them is a new release.
 */
const computeRelease = Effect.gen(function* () {
  if (typeof SUPABASE_STACK_BUILD_ID === "string")
    return `${packageJson.version}+${SUPABASE_STACK_BUILD_ID}`;
  if (isBunVirtualPath(fileURLToPath(import.meta.url))) {
    const fs = yield* FileSystem.FileSystem;
    const binary = yield* fs.stat(process.execPath);
    const modified = Option.match(binary.mtime, { onNone: () => 0, onSome: (at) => at.getTime() });
    return `${packageJson.version}+binary.${binary.size}.${modified}`;
  }
  return `${packageJson.version}+${yield* stackSourceDigest}`;
}).pipe(Effect.orDie);

/** The release of this build, computed once per process; clients only drive owners of it. */
export const currentRelease: Effect.Effect<
  string,
  never,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto
> = Effect.runSync(Effect.cached(computeRelease));

/**
 * Control requests carry the owner secret as a bearer token, part of the release-stable contract;
 * HTTP tracing redacts `authorization`, so the secret never reaches span attributes.
 */
export const ownerAuthorization = (secret: string) => `Bearer ${secret}`;

/** Checks a request's `authorization` header against the owner secret in constant time. */
export const authorizes = (header: string | undefined, secret: string) => {
  const expected = ownerAuthorization(secret);
  if (header === undefined || header.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++)
    difference |= expected.charCodeAt(index) ^ header.charCodeAt(index);
  return difference === 0;
};

/** How long a sweeping owner may hold a dead stack's lease. */
export const sweepTimeout = Duration.minutes(1);

export class HostProcessError extends Data.TaggedError("HostProcessError")<{
  readonly operation: string;
  readonly message: string;
  readonly cause?: unknown;
  readonly reason?: HostFailureReason;
}> {}
type HostFailureReason =
  | "unregistered"
  | "not-running"
  | "sweeping"
  | "owner-starting"
  | "connection-failure"
  | "release-mismatch"
  | "runtime-unavailable"
  | "invalid-owner-pid"
  | "owner-exit-pending"
  | "owner-exit-probe";
const HostIdentity = Schema.Struct({
  projectRoot: Schema.String,
  branchContext: Schema.String,
  stackName: Schema.String,
});
export const HostEndpoint = Schema.Struct({
  stackId: Schema.String,
  identity: HostIdentity,
  pid: Schema.Int,
  port: Schema.Int,
  release: Schema.String,
});
export interface HostEndpoint extends Schema.Schema.Type<typeof HostEndpoint> {}

/** A validated owner endpoint and the secret its control requests carry. */
export interface HostAccess {
  readonly endpoint: HostEndpoint;
  readonly secret: string;
}

/** The release-stable body of `POST /shutdown`. */
export const ShutdownRequest = Schema.Struct({ destroy: Schema.Boolean });
/** The release-stable body of a rejected `POST /shutdown`. */
export const ShutdownFailure = Schema.Struct({
  message: Schema.String,
  outcomes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        succeeded: Schema.Boolean,
        error: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
export interface ShutdownFailure extends Schema.Schema.Type<typeof ShutdownFailure> {}

const error = (operation: string, cause: unknown, reason?: HostFailureReason) =>
  new HostProcessError({
    operation,
    message: failureMessage(cause),
    cause,
    ...(reason === undefined ? {} : { reason }),
  });
/** Matches owner failures by reason. */
export const hasReason =
  (...reasons: ReadonlyArray<HostFailureReason>) =>
  (failure: unknown) =>
    failure instanceof HostProcessError &&
    failure.reason !== undefined &&
    reasons.includes(failure.reason);

const causeCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined;
  if ("code" in cause && typeof cause.code === "string") return cause.code;
  if ("cause" in cause) return causeCode(cause.cause);
  return undefined;
};

/** An RPC client whose requests carry the owner secret; a rejected secret is a status failure. */
export const ownerClient = (access: HostAccess) =>
  RpcClient.make(StackRpc).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: `http://127.0.0.1:${access.endpoint.port}/rpc` }).pipe(
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(
          Layer.effect(
            HttpClient.HttpClient,
            HttpClient.HttpClient.pipe(
              Effect.map((client) =>
                client.pipe(
                  HttpClient.mapRequest(HttpClientRequest.bearerToken(access.secret)),
                  HttpClient.filterStatusOk,
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );

/** Anything but a matching answer means the record names a process that no longer serves it. */
const identityOf = Effect.fn("HostProcess.identityOf")(function* (
  stack: SavedStack,
  owner: { readonly port: number; readonly pid: number; readonly secret: string },
) {
  const client = yield* HttpClient.HttpClient;
  const stale = (cause: unknown) => error("connect", cause, "owner-starting");
  const response = yield* client
    .execute(
      HttpClientRequest.get(`http://127.0.0.1:${owner.port}/identity`).pipe(
        HttpClientRequest.bearerToken(owner.secret),
      ),
    )
    .pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(2),
        orElse: () =>
          Effect.fail(
            error(
              "connect",
              "Timed out connecting to the owner control endpoint",
              "connection-failure",
            ),
          ),
      }),
      Effect.mapError((cause) => (cause instanceof HostProcessError ? cause : stale(cause))),
    );
  yield* HttpClientResponse.filterStatusOk(response).pipe(Effect.mapError(stale));
  const remote = yield* HttpClientResponse.schemaBodyJson(HostEndpoint)(response).pipe(
    Effect.mapError(stale),
  );
  if (
    remote.port !== owner.port ||
    remote.pid !== owner.pid ||
    remote.stackId !== stack.id ||
    remote.identity.projectRoot !== stack.identity.projectRoot ||
    remote.identity.branchContext !== stack.identity.branchContext ||
    remote.identity.stackName !== stack.identity.stackName
  )
    return yield* stale("The control endpoint belongs to another process");
  return { endpoint: remote, secret: owner.secret } satisfies HostAccess;
});

const registered = (state: StateInterface, stackId: string) =>
  state
    .read(stackId)
    .pipe(
      Effect.flatMap((stack) =>
        stack === undefined
          ? Effect.fail(error("connect", "Stack is not registered", "unregistered"))
          : Effect.succeed(stack),
      ),
    );

/** Reads the live owner's endpoint without waiting; dead stacks cost no network round trip. */
export const observeHost = Effect.fn("HostProcess.observeHost")(function* (
  state: StateInterface,
  stack: SavedStack,
): Effect.fn.Return<HostEndpoint | undefined, never, HttpClient.HttpClient> {
  return yield* Effect.gen(function* () {
    if (!(yield* state.leased(stack.id))) return undefined;
    const holder = yield* state.readHolder(stack.id);
    if (holder?.role !== "owner") return undefined;
    return (yield* identityOf(stack, holder)).endpoint;
  }).pipe(Effect.orElseSucceed(() => undefined));
});

export interface ConnectOptions {
  /** Accepts an owner of another release, for the release-stable shutdown endpoint. */
  readonly anyRelease?: boolean;
}

/**
 * Resolves the owner holding the stack's lease, waiting while it publishes its endpoint. Fails
 * with `not-running` when no process holds the lease and `sweeping` while a sweeper holds it.
 */
export const connectHost = Effect.fn("HostProcess.connectHost")(function* (
  state: StateInterface,
  stackId: string,
  options: ConnectOptions = {},
): Effect.fn.Return<
  HostAccess,
  HostProcessError | StateError,
  HttpClient.HttpClient | FileSystem.FileSystem | Path.Path | Crypto.Crypto
> {
  const stack = yield* registered(state, stackId);
  const access = yield* Effect.gen(function* () {
    if (!(yield* state.leased(stackId)))
      return yield* error("connect", "Stack owner is not running", "not-running");
    const holder = yield* state.readHolder(stackId);
    if (holder === undefined)
      return yield* error(
        "connect",
        "Stack owner has not published its endpoint",
        "owner-starting",
      );
    if (holder.role === "sweeper")
      return yield* error("connect", "Another owner is sweeping this stack", "sweeping");
    return yield* identityOf(stack, holder);
  }).pipe(
    Effect.retry({
      schedule: Schedule.spaced("50 millis").pipe(Schedule.upTo({ duration: "30 seconds" })),
      while: hasReason("owner-starting"),
    }),
    Effect.mapError((failure) =>
      hasReason("owner-starting")(failure)
        ? error(
            "connect",
            `Stack owner did not become reachable: ${failure.message} (owner log: ${state.ownerLog(stackId)})`,
          )
        : failure,
    ),
  );
  const release = yield* currentRelease;
  if (options.anyRelease !== true && access.endpoint.release !== release)
    return yield* error(
      "connect",
      `Stack ${stackId} is served by release ${access.endpoint.release}, but this client is release ${release}; stop or destroy the stack (both work across releases) and retry`,
      "release-mismatch",
    );
  return access;
});

/** Requests shutdown through the release-stable endpoint; `Some` carries the owner's refusal. */
export const shutdownHost = Effect.fn("HostProcess.shutdownHost")(function* (
  access: HostAccess,
  destroy: boolean,
): Effect.fn.Return<Option.Option<ShutdownFailure>, HostProcessError, HttpClient.HttpClient> {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.post(`http://127.0.0.1:${access.endpoint.port}/shutdown`).pipe(
        HttpClientRequest.bearerToken(access.secret),
        HttpClientRequest.bodyJsonUnsafe({ destroy }),
      ),
    )
    .pipe(
      Effect.mapError((cause) =>
        error(
          "shutdown",
          `Owner response unavailable; the shutdown outcome is uncertain: ${cause.message}`,
        ),
      ),
    );
  if (response.status >= 200 && response.status < 300) return Option.none();
  return Option.some(
    yield* HttpClientResponse.schemaBodyJson(ShutdownFailure)(response).pipe(
      Effect.orElseSucceed(() => ({ message: `Owner rejected shutdown (${response.status})` })),
    ),
  );
});

export interface LaunchOptions {
  readonly stateRoot: string;
  readonly cacheRoot: string;
  readonly stackId: string;
  readonly entrypoint?: string;
  /** Registers this definition once the spawned owner holds the lease. */
  readonly register?: SavedStack;
  /** Ties a spawned owner to the enclosing scope, whose closure destroys the stack. */
  readonly lifeline?: boolean;
}
const readyLine = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready"), endpoint: HostEndpoint, secret: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("error"),
    message: Schema.String,
    reason: Schema.optionalKey(Schema.Literals(["lease-held", "exists", "runtime-unavailable"])),
  }),
]);

const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
const awaitExit = (child: ChildProcess) =>
  Effect.callback<void>((resume) => {
    if (exited(child)) {
      resume(Effect.void);
      return Effect.void;
    }
    const done = () => resume(Effect.void);
    child.once("exit", done);
    child.once("error", done);
    return Effect.sync(() => {
      child.off("exit", done);
      child.off("error", done);
    });
  });
const signal = (child: ChildProcess, name: NodeJS.Signals) =>
  Effect.sync(() => {
    if (exited(child) || child.pid === undefined) return;
    try {
      if (process.platform === "win32") child.kill(name);
      else process.kill(-child.pid, name);
    } catch {
      child.kill(name);
    }
  });
const terminate = (child: ChildProcess) =>
  signal(child, "SIGTERM").pipe(
    Effect.andThen(awaitExit(child)),
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => signal(child, "SIGKILL").pipe(Effect.andThen(awaitExit(child))),
    }),
  );

/** Ends the lifeline and waits for the owner to finish destroying the stack. */
const closeLifeline = (child: ChildProcess) =>
  Effect.sync(() => child.stdin?.end()).pipe(
    Effect.andThen(awaitExit(child)),
    Effect.timeoutOrElse({
      duration: "2 minutes",
      orElse: () => Effect.logWarning(`Stack owner ${child.pid} is still destroying its stack`),
    }),
  );

/** Reads the end of the owner log through the spawner's descriptor, which outlives its unlink. */
const logTail = (descriptor: number) => {
  try {
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, 4096);
    const bytes = Buffer.alloc(length);
    readSync(descriptor, bytes, 0, length, size - length);
    const lines = bytes.toString("utf8").trimEnd().split("\n").slice(-20);
    return lines.join("\n");
  } catch {
    return "";
  }
};

type Spawned =
  | { readonly _tag: "Ready"; readonly access: HostAccess }
  | { readonly _tag: "LeaseHeld" };

const spawnOwner = Effect.fn("HostProcess.spawnOwner")(function* (
  state: StateInterface,
  options: LaunchOptions,
  entrypoint: string,
): Effect.fn.Return<Spawned, HostProcessError, Scope.Scope | FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const log = state.ownerLog(options.stackId);
  yield* fs
    .makeDirectory(path.dirname(log), { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError((cause) => error("startup", cause)));
  const register =
    options.register === undefined
      ? []
      : [
          yield* Schema.encodeEffect(Schema.fromJsonString(SavedStack))(options.register).pipe(
            Effect.mapError((cause) => error("startup", cause)),
          ),
        ];
  return yield* Effect.acquireUseRelease(
    Effect.try({
      try: () => openSync(log, "a+", 0o600),
      catch: (cause) => error("startup", `Cannot open the owner log ${log}: ${String(cause)}`),
    }),
    (descriptor) =>
      Effect.gen(function* () {
        const failure = (cause: unknown, reason?: HostFailureReason) => {
          const tail = logTail(descriptor);
          return error(
            "startup",
            `Stack owner failed to start: ${error("startup", cause).message} (owner log: ${log})${tail.length === 0 ? "" : `\n${tail}`}`,
            reason,
          );
        };
        const spawnFailed = yield* Deferred.make<never, HostProcessError>();
        return yield* Effect.acquireUseRelease(
          Effect.try({
            try: () => {
              const started = spawn(
                process.execPath,
                [entrypoint, options.stateRoot, options.cacheRoot, options.stackId, ...register],
                {
                  cwd: process.cwd(),
                  detached: true,
                  windowsHide: true,
                  stdio: [
                    options.lifeline === true ? "pipe" : "ignore",
                    descriptor,
                    descriptor,
                    "pipe",
                  ],
                },
              );
              started.on("error", (cause) => {
                Deferred.doneUnsafe(spawnFailed, Exit.fail(failure(cause)));
              });
              return started;
            },
            catch: failure,
          }),
          (child) =>
            Effect.gen(function* () {
              const readiness = child.stdio[3];
              const line = yield* (
                readiness === null || readiness === undefined || !("read" in readiness)
                  ? Effect.fail(failure("Owner readiness descriptor is unavailable"))
                  : NodeStream.fromReadable({ evaluate: () => readiness, onError: failure }).pipe(
                      Stream.decodeText,
                      Stream.splitLines,
                      Stream.runHead,
                      Effect.flatMap(
                        Option.match({
                          onNone: () =>
                            Effect.fail(failure("Owner exited before reporting readiness")),
                          onSome: Effect.succeed,
                        }),
                      ),
                      Effect.timeoutOrElse({
                        duration: "30 seconds",
                        orElse: () => Effect.fail(failure("Timed out waiting for owner readiness")),
                      }),
                    )
              ).pipe(
                Effect.raceFirst(Deferred.await(spawnFailed)),
                Effect.flatMap((text) =>
                  Schema.decodeEffect(Schema.fromJsonString(readyLine))(text).pipe(
                    Effect.mapError(failure),
                  ),
                ),
                Effect.ensuring(Effect.sync(() => readiness?.destroy())),
              );
              if (line.type === "error") {
                yield* awaitExit(child).pipe(Effect.timeout("5 seconds"), Effect.ignore);
                if (line.reason === "lease-held" && options.register === undefined)
                  return { _tag: "LeaseHeld" } as const;
                return yield* line.reason === "lease-held" || line.reason === "exists"
                  ? error("startup", "Stack already exists; use open")
                  : failure(line.message, line.reason);
              }
              if (line.endpoint.stackId !== options.stackId)
                return yield* failure(
                  "Owner readiness identity does not match the requested stack",
                );
              child.unref();
              if (options.lifeline === true) {
                const stdin = child.stdin;
                // Ending the lifeline of an owner that already exited reports EPIPE, which changes nothing.
                stdin?.on("error", () => undefined);
                if (
                  stdin !== null &&
                  Predicate.hasProperty(stdin, "unref") &&
                  typeof stdin.unref === "function"
                )
                  stdin.unref();
                yield* Effect.addFinalizer(() => closeLifeline(child));
              }
              return {
                _tag: "Ready",
                access: { endpoint: line.endpoint, secret: line.secret },
              } as const;
            }),
          (child, exit) => (Exit.isSuccess(exit) ? Effect.void : terminate(child)),
        );
      }),
    (descriptor) => Effect.sync(() => closeSync(descriptor)),
  );
});

/** Connects to the stack's live owner, or spawns one and attaches to whichever owner wins the lease. */
export const launchHost = Effect.fn("HostProcess.launchHost")(function* (
  state: StateInterface,
  options: LaunchOptions,
): Effect.fn.Return<
  HostAccess,
  HostProcessError | StateError,
  Scope.Scope | HttpClient.HttpClient | FileSystem.FileSystem | Path.Path | Crypto.Crypto
> {
  const entrypoint = options.entrypoint ?? hostEntrypointFor(import.meta.url);
  const attempt = Effect.gen(function* () {
    if (options.register === undefined) {
      const existing = yield* connectHost(state, options.stackId).pipe(
        Effect.map(Option.some),
        Effect.catchIf(hasReason("not-running"), () => Effect.succeed(Option.none())),
      );
      if (Option.isSome(existing)) return existing.value;
    }
    const spawned = yield* spawnOwner(state, options, entrypoint);
    return spawned._tag === "Ready" ? spawned.access : yield* connectHost(state, options.stackId);
  });
  // A sweeper holds a dead stack's lease for a bounded time; a displaced spawn waits it out.
  return yield* attempt.pipe(
    Effect.retry({
      schedule: Schedule.spaced("100 millis").pipe(
        Schedule.upTo({ duration: Duration.sum(sweepTimeout, Duration.seconds(10)) }),
      ),
      while: hasReason("not-running", "sweeping"),
    }),
  );
});

export type OwnerExitProbeResult =
  | { readonly state: "absent" }
  | { readonly state: "present" }
  | { readonly state: "inconclusive"; readonly code: "EPERM" };
export type OwnerExitProbe = (pid: number) => Effect.Effect<OwnerExitProbeResult, HostProcessError>;

/** Probes the captured owner PID with signal 0. */
const probeOwnerExit: OwnerExitProbe = Effect.fn("HostProcess.probeOwnerExit")(function* (pid) {
  return yield* Effect.try({
    try: () => {
      process.kill(pid, 0);
      return { state: "present" } as const;
    },
    catch: (cause) =>
      new HostProcessError({
        operation: "shutdown-exit",
        message: `Shutdown acknowledged, but probing owner process ${pid} failed: ${String(cause)}`,
        reason: "owner-exit-probe",
        cause,
      }),
  }).pipe(
    Effect.catch((failure): Effect.Effect<OwnerExitProbeResult, HostProcessError> => {
      const code = causeCode(failure.cause);
      if (code === "ESRCH") return Effect.succeed({ state: "absent" } as const);
      if (code === "EPERM") return Effect.succeed({ state: "inconclusive", code } as const);
      return Effect.fail(failure);
    }),
  );
});

/** Waits until the captured owner PID is absent from the process table. */
export const waitForOwnerExit = Effect.fn("HostProcess.waitForOwnerExit")(function* (
  pid: number,
  probe: OwnerExitProbe = probeOwnerExit,
) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return yield* error(
      "shutdown-exit",
      `Owner endpoint returned an invalid PID: ${pid}`,
      "invalid-owner-pid",
    );
  const check = probe(pid).pipe(
    Effect.flatMap((result) =>
      result.state === "absent"
        ? Effect.void
        : Effect.fail(
            error(
              "shutdown-exit",
              result.state === "present"
                ? `Owner shutdown acknowledgement completed, but process ${pid} is still running`
                : `Owner shutdown acknowledgement completed, but process ${pid} is inaccessible (${result.code}); exit is inconclusive`,
              "owner-exit-pending",
            ),
          ),
    ),
  );
  return yield* check.pipe(
    Effect.retry({
      schedule: Schedule.spaced("25 millis").pipe(Schedule.upTo({ duration: "5 seconds" })),
      while: (failure) => failure.reason === "owner-exit-pending",
    }),
  );
});

const hostEntrypointFor = (moduleUrl: string): string => {
  if (isBunVirtualPath(moduleUrl)) return HOST_PROCESS_DISPATCH_SENTINEL;
  const sourceEntrypoint = fileURLToPath(new URL("./internal/host-process.ts", moduleUrl));
  return isBunVirtualPath(sourceEntrypoint) ? HOST_PROCESS_DISPATCH_SENTINEL : sourceEntrypoint;
};
