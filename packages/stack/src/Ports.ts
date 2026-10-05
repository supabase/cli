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
  Scope,
} from "effect";
import * as Net from "node:net";
import type * as StackNamespace from "./StackNamespace.ts";
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

export class PortError extends Data.TaggedError("PortError")<{
  readonly key: string;
  readonly message: string;
  readonly cause?: unknown;
  readonly conflict?: PortConflict;
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
        message: `Port ${port} for ${key} at ${host}:${port} is already in use`,
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
  stack: StackNamespace.SavedStack,
  request: PortRequest,
  owned: number | undefined,
): Effect.Effect<
  { readonly saved: StackNamespace.PortClaim | undefined; readonly requested: number | "auto" },
  PortError
> => {
  const saved = stack.ports.find((entry) => entry.key === request.key);
  if (saved !== undefined && saved.host !== request.host)
    return Effect.fail(
      new PortError({
        key: request.key,
        message: "The requested listener differs from its saved assignment",
      }),
    );
  const expected = owned ?? saved?.port;
  if (request.port !== "auto" && expected !== undefined && expected !== request.port)
    return Effect.fail(
      new PortError({
        key: request.key,
        message: "The requested listener differs from its reserved assignment",
      }),
    );
  const requested = expected ?? request.port;
  if (requested === "auto") return Effect.succeed({ saved, requested });
  if (!Number.isInteger(requested) || requested < 1 || requested > 65535)
    return Effect.fail(new PortError({ key: request.key, message: "Invalid public port" }));
  if (requested >= nativePortBase && requested < portBase)
    return Effect.fail(
      new PortError({
        key: request.key,
        message: `Public port ${requested} is inside ${nativePortBase}-${portBase - 1}, which is reserved for native service ports; choose a port outside that range`,
      }),
    );
  return Effect.succeed({ saved, requested });
};

/**
 * One stack's public ports, reserved through the per-user registry before any physical listener
 * exists: a reservation is committed first, then the listener is created, so a stopped stack's
 * ports stay reserved across every other stack's starts and across state roots.
 */
export const makePorts = (state: StackNamespace.Interface) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const portReservations = yield* PortReservations.Service;
    // The registry's state_root is the realpath, so a symlinked or relative root still matches
    // the identity another process derives from the same stack.
    const stateRoot = yield* fs.realPath(state.root);

    const describe = (holder: Holder) => `stack ${holder.stackId} at ${holder.stateRoot}`;

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
     * Reserves `port` for `(stackId, key)`, running the lazy-reclamation check against a live
     * conflict's own registration before giving up on it. Resolves to the still-live holder on
     * conflict, or `undefined` once the row is ours. Untraced: an auto scan calls this per
     * candidate port, and the enclosing `Ports.acquire` span already records the attempt count.
     */
    const reserveCandidate = Effect.fnUntraced(function* (
      stackId: string,
      key: string,
      port: number,
    ) {
      const holder = yield* portReservations.reserve(stateRoot, stackId, key, port);
      if (holder === undefined) return undefined;
      if (!(yield* isGone(holder))) return holder;
      const reclaimed = yield* portReservations.reclaim(port, holder, {
        stateRoot,
        stackId,
        endpoint: key,
      });
      return reclaimed ? undefined : holder;
    });

    const holderMessage = (key: string, port: number, stackId: string, holder: Holder) =>
      holder.stackId === stackId
        ? `Public port ${port} for ${key} is claimed by another listener of this stack`
        : `Public port ${port} for ${key} is claimed by ${describe(holder)}`;

    const acquire = Effect.fn("Ports.acquire")(function* <A, R>(
      request: PortRequest,
      bind: (host: string, port: number) => Effect.Effect<A, PortError, R | Scope.Scope>,
    ) {
      return yield* state.withLock(
        Effect.gen(function* () {
          const stack = yield* state.read(request.stackId);
          if (stack === undefined)
            return yield* new PortError({ key: request.key, message: "Stack is not registered" });
          const owned = yield* portReservations.find(stateRoot, request.stackId, request.key);
          const { saved, requested } = yield* resolveRequest(stack, request, owned);
          const owner = yield* Scope.Scope;
          yield* Effect.annotateCurrentSpan({
            "stack.endpoint": request.key,
            "stack.port.mode":
              requested !== "auto" ? (owned !== undefined ? "owned" : "fixed") : "auto",
          });

          const publishIfNeeded = (port: number) =>
            saved === undefined || saved.port !== port || saved.host !== request.host
              ? state.save({
                  ...stack,
                  ports: [
                    ...stack.ports.filter((entry) => entry.key !== request.key),
                    { key: request.key, host: request.host, port },
                  ],
                })
              : Effect.void;

          /** Binds `port` and publishes it, against whatever scope the caller provides. */
          const bindAndPublish = (port: number) =>
            Effect.gen(function* () {
              const listener = yield* bind(request.host, port).pipe(
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
              yield* publishIfNeeded(port);
              return { port, listener };
            });

          /**
           * One bind attempt at `port`, in its own forked scope so a failure rolls back both the
           * listener and the `state.json` publish together; a success holds the scope open instead.
           */
          const attemptBind = (port: number) =>
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const scope = yield* Scope.fork(owner, "sequential");
                return yield* restore(
                  bindAndPublish(port).pipe(Effect.provideService(Scope.Scope, scope)),
                ).pipe(
                  Effect.onExit((exit) =>
                    Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void,
                  ),
                  Effect.exit,
                );
              }),
            );

          if (requested !== "auto") {
            if (owned === undefined) {
              const holder = yield* reserveCandidate(request.stackId, request.key, requested);
              if (holder !== undefined)
                return yield* new PortError({
                  key: request.key,
                  message: holderMessage(request.key, requested, request.stackId, holder),
                  conflict: { port: requested, endpoint: request.key, holder },
                });
            }
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
            // Owning this port already, or reserving it exactly, is sticky: a bind failure never
            // reassigns it, and the reservation survives so the next attempt retries this port.
            return yield* error.value;
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
                const holder = yield* reserveCandidate(request.stackId, request.key, port);
                if (holder !== undefined) return undefined;
                const scope = yield* Scope.fork(owner, "sequential");
                return yield* restore(
                  bindAndPublish(port).pipe(Effect.provideService(Scope.Scope, scope)),
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

    const release = Effect.fn("Ports.release")(function* (stackId: string, key: string) {
      yield* state.withLock(
        Effect.gen(function* () {
          yield* portReservations.release(stateRoot, stackId, key);
          const stack = yield* state.read(stackId);
          if (stack !== undefined)
            yield* state.save({
              ...stack,
              ports: stack.ports.filter((entry) => entry.key !== key),
            });
        }),
      );
    });

    /** Releases every reservation a stack holds, regardless of endpoint; used at destroy's success boundary. */
    const releaseStack = Effect.fn("Ports.releaseStack")(function* (stackId: string) {
      yield* portReservations.releaseStack(stateRoot, stackId);
    });

    return { acquire, release, releaseStack };
  });
