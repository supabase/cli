import { Cause, Crypto, Data, Effect, Exit, Option, Scope } from "effect";
import type * as State from "./State.ts";

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

/** Coordinates durable public claims while retaining each successfully bound listener. */
export const makePorts = (state: State.Interface) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;

    const acquire = Effect.fn("Ports.acquire")(
      <A, R>(
        request: PortRequest,
        bind: (host: string, port: number) => Effect.Effect<A, PortError, R | Scope.Scope>,
      ) =>
        state.withLock(
          Effect.gen(function* () {
            const stack = yield* state.read(request.stackId);
            if (stack === undefined)
              return yield* new PortError({ key: request.key, message: "Stack is not registered" });
            const saved = stack.ports.find((entry) => entry.key === request.key);
            if (
              saved !== undefined &&
              (saved.host !== request.host ||
                (request.port !== "auto" && saved.port !== request.port))
            )
              return yield* new PortError({
                key: request.key,
                message: "The requested listener differs from its saved assignment",
              });
            const requested = saved?.port ?? request.port;
            if (
              requested !== "auto" &&
              (!Number.isInteger(requested) || requested < 1 || requested > 65535)
            )
              return yield* new PortError({ key: request.key, message: "Invalid public port" });

            const claimed = new Set<number>();
            for (const other of yield* state.list)
              for (const claim of other.ports)
                if (other.id !== request.stackId || claim.key !== request.key)
                  claimed.add(claim.port);
            if (requested !== "auto" && claimed.has(requested))
              return yield* new PortError({
                key: request.key,
                message: `Public port ${requested} is claimed by another listener`,
              });

            const owner = yield* Scope.Scope;
            const first = yield* crypto.randomIntBetween(0, 29999);
            let failures = 0;
            for (let attempt = 0; attempt < 30000 && failures < 64; attempt++) {
              const port = requested === "auto" ? 20000 + ((first + attempt) % 30000) : requested;
              if (claimed.has(port)) continue;
              const result = yield* Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const scope = yield* Scope.fork(owner, "sequential");
                  return yield* restore(
                    Effect.gen(function* () {
                      const listener = yield* bind(request.host, port).pipe(
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
                      Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void,
                    ),
                    Effect.exit,
                  );
                }),
              );
              if (Exit.isSuccess(result)) return result.value;
              const error = Cause.findErrorOption(result.cause);
              if (
                requested !== "auto" ||
                Exit.hasInterrupts(result) ||
                Exit.hasDies(result) ||
                Option.isNone(error) ||
                !(error.value instanceof PortError)
              )
                return yield* Effect.failCause(result.cause);
              failures++;
            }
            return yield* new PortError({
              key: request.key,
              message: "No public port is available",
            });
          }),
        ),
    );

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
