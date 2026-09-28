import { Cause, Data, Effect, Exit, Hash, Option, Scope } from "effect";
import * as Net from "node:net";
import type * as State from "./State.ts";

const portBase = 20000;
/** Stays below the Linux ephemeral range, per the [architecture ADR](../../../docs/adr/0017-simplified-managed-stack-architecture.md). */
const portSpan = 12768;
/** Co-prime with the span, so the scan visits every port once and steps past reserved ranges. */
const portStride = 257;

export class PortError extends Data.TaggedError("PortError")<{
  readonly key: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface PortRequest {
  readonly stackId: string;
  readonly key: string;
  readonly host: string;
  readonly port: number | "auto";
}

/** Spreads the scan across the span so separate checkouts, stacks, and keys start apart. */
const scanStart = (stack: State.SavedStack, key: string) =>
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

const loopbackOccupied = (port: number) =>
  Effect.forEach(["127.0.0.1", "::1"], (host) => accepts(host, port), {
    concurrency: "unbounded",
  }).pipe(Effect.map((answers) => answers.some(Boolean)));

const claimantOf = (stacks: ReadonlyArray<State.StackClaims>, stackId: string, port: number) =>
  stacks.find((other) => other.id !== stackId && other.ports.some((claim) => claim.port === port))
    ?.id;

const resolveRequest = (
  stack: State.SavedStack,
  request: PortRequest,
): Effect.Effect<
  { readonly saved: State.PortClaim | undefined; readonly requested: number | "auto" },
  PortError
> => {
  const saved = stack.ports.find((entry) => entry.key === request.key);
  if (
    saved !== undefined &&
    (saved.host !== request.host || (request.port !== "auto" && saved.port !== request.port))
  )
    return Effect.fail(
      new PortError({
        key: request.key,
        message: "The requested listener differs from its saved assignment",
      }),
    );
  const requested = saved?.port ?? request.port;
  if (requested === "auto") return Effect.succeed({ saved, requested });
  if (!Number.isInteger(requested) || requested < 1 || requested > 65535)
    return Effect.fail(new PortError({ key: request.key, message: "Invalid public port" }));
  if (stack.ports.some((claim) => claim.key !== request.key && claim.port === requested))
    return Effect.fail(
      new PortError({
        key: request.key,
        message: `Public port ${requested} is claimed by another listener of this stack`,
      }),
    );
  return Effect.succeed({ saved, requested });
};

/** Claims steer auto allocation away from saved stacks; live listeners and binds decide conflicts for fixed ports. */
export const makePorts = (state: State.Interface, platform: NodeJS.Platform = process.platform) =>
  Effect.sync(() => {
    const describe = (id: string) =>
      state.read(id).pipe(
        Effect.map((saved) =>
          saved === undefined
            ? id
            : `"${saved.identity.stackName}" on ${saved.identity.branchContext} in ${saved.identity.projectRoot}`,
        ),
        Effect.orElseSucceed(() => id),
      );

    const claimedBy = (stacks: ReadonlyArray<State.StackClaims>, stackId: string, port: number) => {
      const claimant = claimantOf(stacks, stackId, port);
      return claimant === undefined
        ? Effect.succeed("")
        : describe(claimant).pipe(Effect.map((stack) => `; stack ${stack} claims this port`));
    };

    // A caller may serve several claims of one stack from a listener it acquired here, so that
    // listener is not a foreign occupant.
    const held = new Map<string, number>();
    const hold = (scope: Scope.Scope, stackId: string, port: number) => {
      const key = `${stackId}:${port}`;
      return Effect.sync(() => held.set(key, (held.get(key) ?? 0) + 1)).pipe(
        Effect.andThen(
          Scope.addFinalizer(
            scope,
            Effect.sync(() => {
              const remaining = (held.get(key) ?? 1) - 1;
              if (remaining > 0) held.set(key, remaining);
              else held.delete(key);
            }),
          ),
        ),
      );
    };

    /** Advisory and outside the registry lock; the bind under the lock still decides. */
    const rejectOccupied = Effect.fn("Ports.rejectOccupied")(function* (request: PortRequest) {
      const preview = yield* state.read(request.stackId);
      if (preview === undefined) return;
      const { requested } = yield* resolveRequest(preview, request);
      if (
        requested === "auto" ||
        !bindsCanOverlap(platform) ||
        held.has(`${request.stackId}:${requested}`) ||
        !(yield* loopbackOccupied(requested))
      )
        return;
      const message = `Public port ${requested} for ${request.key} at ${request.host}:${requested} is already in use`;
      return yield* new PortError({
        key: request.key,
        message: `${message}${yield* claimedBy(yield* state.claims, request.stackId, requested)}`,
        // Owners classify an occupied port by this errno, as they do for a failed bind.
        cause: Object.assign(new Error(message), { code: "EADDRINUSE" }),
      });
    });

    const acquire = Effect.fn("Ports.acquire")(function* <A, R>(
      request: PortRequest,
      bind: (host: string, port: number) => Effect.Effect<A, PortError, R | Scope.Scope>,
    ) {
      yield* rejectOccupied(request);
      return yield* state.withLock(
        Effect.gen(function* () {
          const stack = yield* state.read(request.stackId);
          if (stack === undefined)
            return yield* new PortError({ key: request.key, message: "Stack is not registered" });
          const { saved, requested } = yield* resolveRequest(stack, request);
          const others = yield* state.claims;
          const claimed = new Set([
            ...stack.ports.filter((claim) => claim.key !== request.key).map((claim) => claim.port),
            ...others
              .filter((other) => other.id !== request.stackId)
              .flatMap((other) => other.ports.map((claim) => claim.port)),
          ]);

          const owner = yield* Scope.Scope;
          const start = scanStart(stack, request.key);
          let failures = 0;
          let lastFailure: PortError | undefined;
          for (let attempt = 0; attempt < portSpan && failures < 64; attempt++) {
            const port =
              requested === "auto"
                ? portBase + ((start + attempt * portStride) % portSpan)
                : requested;
            if (requested === "auto" && claimed.has(port)) continue;
            const result = yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                const scope = yield* Scope.fork(owner, "sequential");
                return yield* restore(
                  Effect.gen(function* () {
                    const listener = yield* bind(request.host, port).pipe(
                      Effect.mapError(
                        (cause) =>
                          new PortError({
                            key: request.key,
                            message: `Cannot bind ${request.key} at ${request.host}:${port}: ${cause.message}`,
                            cause,
                          }),
                      ),
                      Effect.provideService(Scope.Scope, scope),
                    );
                    if (saved === undefined)
                      yield* state.save({
                        ...stack,
                        ports: [...stack.ports, { key: request.key, host: request.host, port }],
                      });
                    return { port, listener };
                  }),
                ).pipe(
                  Effect.onExit((exit) =>
                    Exit.isFailure(exit)
                      ? Scope.close(scope, exit)
                      : hold(scope, request.stackId, port),
                  ),
                  Effect.exit,
                );
              }),
            );
            if (Exit.isSuccess(result)) return result.value;
            const error = Cause.findErrorOption(result.cause);
            if (
              Exit.hasInterrupts(result) ||
              Exit.hasDies(result) ||
              Option.isNone(error) ||
              !(error.value instanceof PortError)
            )
              return yield* Effect.failCause(result.cause);
            if (requested !== "auto")
              return yield* new PortError({
                key: request.key,
                message: `${error.value.message}${yield* claimedBy(others, request.stackId, requested)}`,
                cause: error.value.cause,
              });
            failures++;
            lastFailure = error.value;
          }
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
          const stack = yield* state.read(stackId);
          if (stack !== undefined)
            yield* state.save({
              ...stack,
              ports: stack.ports.filter((entry) => entry.key !== key),
            });
        }),
      );
    });

    return { acquire, release };
  });
