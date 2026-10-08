import {
  Cause,
  Data,
  Effect,
  Exit,
  FileSystem,
  Hash,
  Option,
  Path,
  Predicate,
  Schema,
  Scope,
} from "effect";
import * as Net from "node:net";
import type { StackFailureKind } from "./FailureKind.ts";
import type * as StackNamespace from "./StackNamespace.ts";
import * as Lease from "./namespace/Lease.ts";
import * as PortReservations from "./namespace/PortReservations.ts";
import type { Holder } from "./namespace/PortReservations.ts";

const portBase = 20000;
/** Stays below the Linux ephemeral range, per the [architecture ADR](../../../docs/adr/0017-simplified-managed-stack-architecture.md). */
const portSpan = 12768;
/** Co-prime with the span, so the scan visits every port once and steps past reserved ranges. */
const portStride = 257;

/** Why a port could not be used: another stack's live reservation, or a process outside the registry. */
export interface PortConflict {
  readonly port: number;
  readonly endpoint: string;
  readonly holder: Holder | "foreign";
}

/** Without a `kind`, the failure is the stack's own allocation (`port-allocation`). */
export class PortError extends Data.TaggedError("PortError")<{
  readonly key: string;
  readonly message: string;
  readonly cause?: unknown;
  readonly conflict?: PortConflict;
  readonly kind?: StackFailureKind;
}> {}

export interface PortRequest {
  readonly stackId: string;
  readonly key: string;
  readonly host: string;
  readonly port: number | "auto";
}

/** Spreads the scan across the span so separate checkouts, stacks, and keys start apart. */
const scanStart = (stack: StackNamespace.SavedStack, key: string) =>
  Math.abs(Hash.string(`${stack.identity.projectRoot}:${stack.id}:${key}`)) % portSpan;

/** A wildcard listener is reachable through loopback, where a same-port loopback listener answers too. */
const probeHost = (host: string) =>
  host === "0.0.0.0" ? "127.0.0.1" : host === "::" ? "::1" : host;

/** A refused loopback connect can take seconds on Windows, so silence within the bound counts as vacant. */
export const accepts = (host: string, port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = Net.connect({ host: probeHost(host), port });
    const settle = (listening: boolean) => {
      socket.destroy();
      resume(Effect.succeed(listening));
    };
    socket.once("connect", () => settle(true));
    socket.on("error", () => settle(false));
    return Effect.sync(() => {
      socket.destroy();
    });
  }).pipe(Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.succeed(false) }));

/** Linux rejects a bind that overlaps a same-family listener on the port; macOS, BSD, and Windows accept it. */
const bindsCanOverlap = (platform: NodeJS.Platform) => platform !== "linux";

const isRefused = (cause: unknown) =>
  Predicate.hasProperty(cause, "code") && cause.code === "ECONNREFUSED";

/** A refused loopback connect can take seconds on Windows; darwin and linux answer almost immediately. */
const refusalTimeout = (platform: NodeJS.Platform) =>
  platform === "win32" ? "3 seconds" : "250 millis";

/**
 * Resolves `true` only on a definite `ECONNREFUSED`, which is the one outcome that proves nothing
 * answers `host:port`. An accepted connection, a timeout, or any other error (for example
 * `ECONNRESET`) all count as occupied: this is the vacancy probe's own, stricter semantics, kept
 * separate from {@link accepts}'s generous "did anything answer" check that `ProcessRecipe` uses
 * for readiness.
 */
const refused = (platform: NodeJS.Platform) => (host: string, port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = Net.connect({ host: probeHost(host), port });
    const settle = (value: boolean) => {
      socket.destroy();
      resume(Effect.succeed(value));
    };
    socket.once("connect", () => settle(false));
    socket.on("error", (cause: unknown) => settle(isRefused(cause)));
    return Effect.sync(() => {
      socket.destroy();
    });
  }).pipe(
    Effect.timeoutOrElse({
      duration: refusalTimeout(platform),
      orElse: () => Effect.succeed(false),
    }),
  );

const loopbackVacant = (platform: NodeJS.Platform) => (port: number) =>
  Effect.forEach(["127.0.0.1", "::1"], (host) => refused(platform)(host, port), {
    concurrency: "unbounded",
  }).pipe(Effect.map((refusals) => refusals.every(Boolean)));

/** The OS error `bindTcp`/`makeHttpProxy` surface when another process already owns the port. */
const isAddressInUse = (cause: unknown) =>
  Predicate.hasProperty(cause, "code") && cause.code === "EADDRINUSE";

/**
 * Guards a brand-new physical listener only; reusing an existing one never probes. On platforms
 * where overlapping binds silently succeed, only `ECONNREFUSED` on both loopback families proves
 * the port vacant, so anything else (an answer, a timeout, another error) counts as occupied. This
 * narrows, but cannot close, the race between the probe and the real bind that follows it: the OS
 * still allows a foreign process to bind in between on these platforms.
 */
export const probeVacant =
  (platform: NodeJS.Platform) =>
  (key: string, host: string, port: number): Effect.Effect<void, PortError> =>
    Effect.gen(function* () {
      if (!bindsCanOverlap(platform)) return;
      if (yield* loopbackVacant(platform)(port)) return;
      return yield* new PortError({
        key,
        message: `Port ${port} for ${key} at ${host}:${port} is in use by another process; free it or configure a different port for ${key}`,
        conflict: { port, endpoint: key, holder: "foreign" },
      });
    });

/**
 * Disjoint from the public auto range (`portBase`..`portBase + portSpan`) and contiguous below it,
 * and a pinned public port inside it is rejected, so a native backend's direct bind can never land
 * on a port the per-user registry is reserving for a public listener. Both ranges stay below the
 * OS ephemeral range (ADR 0017).
 */
export const nativePortBase = 10000;
export const nativePortSpan = portBase - nativePortBase;
/** Co-prime with the span, matching the public scan's stride. */
const nativePortStride = 257;

export interface NativePortReservation {
  readonly port: number;
  readonly server: Net.Server;
}

const closeNativePort = (server: Net.Server): Effect.Effect<void> =>
  Effect.callback<void, never>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return Effect.void;
    }
    server.close(() => resume(Effect.void));
    return Effect.void;
  });

const bindNativePort = (
  key: string,
  port: number,
): Effect.Effect<NativePortReservation, PortError> =>
  Effect.callback<NativePortReservation, PortError>((resume) => {
    const server = Net.createServer((socket) => socket.destroy());
    const onError = (cause: Error) =>
      resume(
        Effect.fail(
          new PortError({ key, message: "Unable to reserve native service port", cause }),
        ),
      );
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        onError(new Error("Native service port reservation returned no address"));
      } else {
        resume(Effect.succeed({ port: address.port, server }));
      }
    });
    return Effect.sync(() => {
      server.off("error", onError);
      if (server.listening) server.close();
    });
  });

/**
 * Reserves a native backend's private port, hash-seeding the scan from `key` so a reopened
 * instance starts from the same candidate while separate keys spread out (mirrors the public auto
 * scan's hash seed). Probes with {@link probeVacant} before the real bind, since a loopback-only
 * bind can silently coexist with a wildcard listener on macOS, BSD, and Windows. A port a prior
 * attempt in this batch lost is passed in `excluded` so a retry advances instead of repeating it.
 * Never saved: backend ports are private and are not stable across restarts.
 */
export const reserveNativePort = Effect.fn("Ports.reserveNativePort")(
  (
    key: string,
    excluded: ReadonlySet<number>,
    platform: NodeJS.Platform = process.platform,
  ): Effect.Effect<NativePortReservation, PortError, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.gen(function* () {
        const probe = probeVacant(platform);
        const start = Math.abs(Hash.string(key)) % nativePortSpan;
        let failures = 0;
        let lastFailure: PortError | undefined;
        for (let attempt = 0; attempt < nativePortSpan && failures < 64; attempt++) {
          const port = nativePortBase + ((start + attempt * nativePortStride) % nativePortSpan);
          if (excluded.has(port)) continue;
          const probed = yield* Effect.exit(probe(key, "127.0.0.1", port));
          if (Exit.isFailure(probed)) {
            const probeError = Cause.findErrorOption(probed.cause);
            if (Option.isNone(probeError)) return yield* Effect.failCause(probed.cause);
            failures++;
            lastFailure = probeError.value;
            continue;
          }
          const result = yield* Effect.exit(bindNativePort(key, port));
          if (Exit.isSuccess(result)) return result.value;
          const error = Cause.findErrorOption(result.cause);
          if (Option.isNone(error)) return yield* Effect.failCause(result.cause);
          failures++;
          lastFailure = error.value;
        }
        return yield* new PortError({
          key,
          message:
            lastFailure === undefined
              ? "No native service port is available"
              : `No native service port is available: ${lastFailure.message}`,
          cause: lastFailure,
        });
      }),
      ({ server }) => closeNativePort(server),
    ),
);

const resolveRequest = (
  request: PortRequest,
  owned: number | undefined,
): Effect.Effect<number | "auto", PortError> => {
  if (request.port !== "auto" && owned !== undefined && owned !== request.port)
    return Effect.fail(
      new PortError({
        key: request.key,
        message: "The requested listener differs from its reserved assignment",
        kind: "configuration",
      }),
    );
  const requested = owned ?? request.port;
  if (requested === "auto") return Effect.succeed(requested);
  if (!Number.isInteger(requested) || requested < 1 || requested > 65535)
    return Effect.fail(
      new PortError({ key: request.key, message: "Invalid public port", kind: "configuration" }),
    );
  if (requested >= nativePortBase && requested < portBase)
    return Effect.fail(
      new PortError({
        key: request.key,
        message: `Public port ${requested} for ${request.key} is inside ${nativePortBase}-${portBase - 1}, which is reserved for native service backends; configure a port outside that range`,
        kind: "configuration",
      }),
    );
  return Effect.succeed(requested);
};

const RegisteredProject = Schema.fromJsonString(
  Schema.Struct({ identity: Schema.Struct({ projectRoot: Schema.String }) }),
);

/**
 * One stack's public ports, reserved through the per-user registry before any physical listener
 * exists: a reservation is committed first, then the listener is created. An auto port stays
 * reserved while its stack is stopped; a pinned port is reserved only while its listener is open.
 */
export const makePorts = (state: StackNamespace.Interface) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const portReservations = yield* PortReservations.Service;
    // The registry's state_root is the realpath, so a symlinked or relative root still matches
    // the identity another process derives from the same stack.
    const stateRoot = yield* fs.realPath(state.root);
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

    /** The holder's project directory, read from its own registration; undefined when unreadable. */
    const projectOf = (holder: Holder) =>
      fs.readFileString(path.join(holder.stateRoot, holder.stackId, "state.json")).pipe(
        Effect.flatMap(Schema.decodeEffect(RegisteredProject)),
        Effect.map((saved) => saved.identity.projectRoot),
        Effect.orElseSucceed(() => undefined),
      );

    /** Only a confirmed `ENOENT` on the holder's own registration makes its reservation stale. */
    const isGone = (holder: Holder) =>
      fs.stat(path.join(holder.stateRoot, holder.stackId, "state.json")).pipe(
        Effect.as(false),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(true),
        ),
        Effect.orElseSucceed(() => false),
      );

    /**
     * Whether a process holds the holder stack's owner lease; an unreadable lease counts as held.
     * A sweeper holding it does not count, since a sweeper never uses the stack's public ports.
     */
    const isLeased = (holder: Holder) =>
      Lease.make({ root: holder.stateRoot, isRegistered: () => Effect.succeed(true) }).pipe(
        Effect.flatMap((lease) =>
          lease
            .leased(holder.stackId)
            .pipe(
              Effect.flatMap((leased) =>
                leased
                  ? lease.readHolder(holder.stackId).pipe(Effect.map((h) => h?.role !== "sweeper"))
                  : Effect.succeed(false),
              ),
            ),
        ),
        Effect.provideContext(services),
        Effect.orElseSucceed(() => true),
      );

    /**
     * Reserves `port` for `(stackId, key)`, running the lazy-reclamation check against a
     * conflict's own registration before giving up on it. A pinned request also reclaims a
     * holder with no live owner, since the owner that died never closed its listener. Resolves
     * to the still-live holder on conflict, or `undefined` once the row is ours. Untraced: an
     * auto scan calls this per candidate port, and the enclosing `Ports.acquire` span already
     * records the attempt count.
     */
    const reserveCandidate = Effect.fnUntraced(function* (
      stackId: string,
      key: string,
      port: number,
      pinned: boolean,
    ) {
      const holder = yield* portReservations.reserve(stateRoot, stackId, key, port);
      if (holder === undefined) return undefined;
      if (!(yield* isGone(holder)) && !(pinned && !(yield* isLeased(holder)))) return holder;
      const reclaimed = yield* portReservations.reclaim(port, holder, {
        stateRoot,
        stackId,
        endpoint: key,
      });
      return reclaimed ? undefined : holder;
    });

    const holderMessage = Effect.fnUntraced(function* (
      key: string,
      port: number,
      stackId: string,
      holder: Holder,
    ) {
      if (holder.stackId === stackId)
        return `Public port ${port} for ${key} is claimed by another listener of this stack`;
      const project = yield* projectOf(holder);
      const where =
        project === undefined
          ? `stack ${holder.stackId}`
          : `the stack of project ${project} (stack ${holder.stackId})`;
      return `Public port ${port} for ${key} is in use by ${where}; run \`supabase stack stop\` in that project, or configure a different port for ${key}`;
    });

    const acquire = Effect.fn("Ports.acquire")(function* <A, R>(
      request: PortRequest,
      bind: (host: string, port: number) => Effect.Effect<A, PortError, R | Scope.Scope>,
    ) {
      return yield* state.withLock(
        Effect.gen(function* () {
          const stack = yield* state.read(request.stackId);
          if (stack === undefined)
            return yield* new PortError({
              key: request.key,
              message: "Stack is not registered",
              kind: "state",
            });
          const owned = yield* portReservations.find(stateRoot, request.stackId, request.key);
          const requested = yield* resolveRequest(request, owned);
          const owner = yield* Scope.Scope;
          yield* Effect.annotateCurrentSpan({
            "stack.endpoint": request.key,
            "stack.port.mode":
              requested !== "auto" ? (owned !== undefined ? "owned" : "fixed") : "auto",
          });

          /** Binds `port` against whatever scope the caller provides. */
          const bindListener = (port: number) =>
            bind(request.host, port).pipe(
              Effect.map((listener) => ({ port, listener })),
              Effect.mapError(
                (cause) =>
                  new PortError({
                    key: request.key,
                    message: `Cannot bind ${request.key} at ${request.host}:${port}: ${cause.message}`,
                    cause: cause.cause,
                    conflict:
                      cause.conflict ??
                      (isAddressInUse(cause.cause)
                        ? { port, endpoint: request.key, holder: "foreign" as const }
                        : undefined),
                  }),
              ),
            );

          /**
           * One bind attempt at `port` in its own forked scope; a failure closes the scope, a
           * success keeps it open. A pinned request's row lives exactly as long as that scope, so a
           * stopped stack holds none; an auto assignment's row outlives it and is kept across stops.
           */
          const attemptBind = (port: number) =>
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                if (owned === undefined) {
                  const holder = yield* reserveCandidate(
                    request.stackId,
                    request.key,
                    port,
                    request.port !== "auto",
                  );
                  if (holder !== undefined)
                    return Exit.fail(
                      new PortError({
                        key: request.key,
                        message: yield* holderMessage(request.key, port, request.stackId, holder),
                        conflict: { port, endpoint: request.key, holder },
                      }),
                    );
                }
                const scope = yield* Scope.fork(owner, "sequential");
                if (request.port !== "auto")
                  yield* Scope.addFinalizer(
                    scope,
                    portReservations
                      .release(stateRoot, request.stackId, request.key)
                      .pipe(Effect.orDie),
                  );
                return yield* restore(
                  bindListener(port).pipe(Effect.provideService(Scope.Scope, scope)),
                ).pipe(
                  Effect.onExit((exit) =>
                    Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void,
                  ),
                  Effect.exit,
                );
              }),
            );

          if (requested !== "auto") {
            const result = yield* attemptBind(requested);
            if (Exit.isSuccess(result)) return result.value;
            const error = Cause.findErrorOption(result.cause);
            if (
              Exit.hasInterrupts(result) ||
              Exit.hasDies(result) ||
              Option.isNone(error) ||
              !(error.value instanceof PortError)
            )
              return yield* Effect.failCause(result.cause);
            // Only a port the caller requested by number is the user's to change; an owned
            // assignment from an earlier auto allocation is ours.
            return yield* new PortError({
              key: error.value.key,
              message: error.value.message,
              ...(error.value.cause === undefined ? {} : { cause: error.value.cause }),
              ...(error.value.conflict === undefined ? {} : { conflict: error.value.conflict }),
              kind:
                request.port === "auto"
                  ? "port-allocation"
                  : error.value.conflict !== undefined
                    ? "port-conflict"
                    : (error.value.kind ?? "configuration"),
            });
          }

          // A freshly auto-reserved port that fails to bind (including by interruption mid-probe)
          // has no restart stickiness to protect, so it must release the row again. Reserving,
          // forking the listener's scope, attempting the bind, and rolling both back on failure all
          // happen in one uninterruptible mask, with only the bind attempt itself restored to
          // interruptible, mirroring `attemptBind` exactly: a pending interrupt delivered during the
          // probe surfaces inside that single mask, where rollback can never be skipped.
          const attemptCandidate = (port: number) =>
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const holder = yield* reserveCandidate(request.stackId, request.key, port, false);
                if (holder !== undefined) return undefined;
                const scope = yield* Scope.fork(owner, "sequential");
                return yield* restore(
                  bindListener(port).pipe(Effect.provideService(Scope.Scope, scope)),
                ).pipe(
                  Effect.onExit((exit) =>
                    Exit.isFailure(exit)
                      ? Scope.close(scope, exit).pipe(
                          Effect.andThen(
                            portReservations.release(stateRoot, request.stackId, request.key),
                          ),
                        )
                      : Effect.void,
                  ),
                  Effect.exit,
                );
              }),
            );

          const start = scanStart(stack, request.key);
          let failures = 0;
          let lastFailure: PortError | undefined;
          for (let attempt = 0; attempt < portSpan && failures < 64; attempt++) {
            const port = portBase + ((start + attempt * portStride) % portSpan);
            const result = yield* attemptCandidate(port);
            if (result === undefined) continue;
            if (Exit.isSuccess(result)) {
              yield* Effect.annotateCurrentSpan({ "stack.port.attempts": attempt + 1 });
              return result.value;
            }
            const error = Cause.findErrorOption(result.cause);
            if (
              Exit.hasInterrupts(result) ||
              Exit.hasDies(result) ||
              Option.isNone(error) ||
              !(error.value instanceof PortError)
            )
              return yield* Effect.failCause(result.cause);
            failures++;
            lastFailure = error.value;
          }
          yield* Effect.annotateCurrentSpan({ "stack.port.failures": failures });
          return yield* new PortError({
            key: request.key,
            message:
              lastFailure === undefined
                ? "No public port is available"
                : `No public port is available: ${lastFailure.message}`,
            cause: lastFailure,
          });
        }),
      );
    });

    /** The port this stack's reservation holds for `key`, or `undefined` when it holds none. */
    const assigned = Effect.fn("Ports.assigned")((stackId: string, key: string) =>
      portReservations.find(stateRoot, stackId, key),
    );

    const release = Effect.fn("Ports.release")(function* (stackId: string, key: string) {
      yield* state.withLock(portReservations.release(stateRoot, stackId, key));
    });

    /** Releases every reservation a stack holds, regardless of endpoint; used at destroy's success boundary. */
    const releaseStack = Effect.fn("Ports.releaseStack")(function* (stackId: string) {
      yield* portReservations.releaseStack(stateRoot, stackId);
    });

    return { acquire, assigned, release, releaseStack };
  });
