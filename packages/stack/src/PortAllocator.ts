import { createServer } from "node:net";
import { Data, Effect } from "effect";

export const DEFAULT_API_PORT = 54321;
export const DEFAULT_DB_PORT = 54322;

export class PortAllocationError extends Data.TaggedError("PortAllocationError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export interface PortInput {
  readonly apiPort?: number;
  readonly dbPort?: number;
  readonly authPort?: number;
  readonly postgrestPort?: number;
  readonly postgrestAdminPort?: number;
}

export interface AllocatedPorts {
  readonly apiPort: number;
  readonly dbPort: number;
  readonly authPort: number;
  readonly postgrestPort: number;
  readonly postgrestAdminPort: number;
}

/** Bind port 0 to get an OS-assigned random port, then close immediately. */
const probeRandomPort = (
  exclude: ReadonlySet<number>,
): Effect.Effect<number, PortAllocationError> =>
  Effect.flatMap(
    Effect.callback<number, PortAllocationError>((resume) => {
      const server = createServer();
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr !== null ? addr.port : 0;
        server.close(() => resume(Effect.succeed(port)));
      });
      server.on("error", (cause) =>
        resume(
          Effect.fail(new PortAllocationError({ detail: "Failed to bind random port", cause })),
        ),
      );
      return Effect.void;
    }),
    (port) => (exclude.has(port) ? probeRandomPort(exclude) : Effect.succeed(port)),
  );

/** Probe the exact port requested by the user. Fail if it is not available. */
const probeExactPort = (port: number): Effect.Effect<number, PortAllocationError> =>
  Effect.callback<number, PortAllocationError>((resume) => {
    const server = createServer();
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resume(Effect.succeed(port)));
    });
    server.on("error", () =>
      resume(Effect.fail(new PortAllocationError({ detail: `Port ${port} is not available` }))),
    );
    return Effect.void;
  });

export const allocatePorts = (
  input: PortInput,
): Effect.Effect<AllocatedPorts, PortAllocationError> =>
  Effect.gen(function* () {
    const allocated = new Set<number>();

    const alloc = (port: number) => {
      allocated.add(port);
      return port;
    };

    // Explicit port → error if unavailable. No port → random.
    const apiPort = alloc(
      yield* input.apiPort !== undefined
        ? probeExactPort(input.apiPort)
        : probeRandomPort(allocated),
    );

    const dbPort = alloc(
      yield* input.dbPort !== undefined ? probeExactPort(input.dbPort) : probeRandomPort(allocated),
    );

    const authPort = alloc(
      yield* input.authPort !== undefined
        ? probeExactPort(input.authPort)
        : probeRandomPort(allocated),
    );

    const postgrestPort = alloc(
      yield* input.postgrestPort !== undefined
        ? probeExactPort(input.postgrestPort)
        : probeRandomPort(allocated),
    );

    const postgrestAdminPort = alloc(
      yield* input.postgrestAdminPort !== undefined
        ? probeExactPort(input.postgrestAdminPort)
        : probeRandomPort(allocated),
    );

    return { apiPort, dbPort, authPort, postgrestPort, postgrestAdminPort };
  });
