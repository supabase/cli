import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { Effect } from "effect";
import { allocatePorts, DEFAULT_PORTS, PortAllocationError } from "./PortAllocator.ts";

const listen = (port: number) =>
  Effect.callback<Server, Error>((resume) => {
    const server = createServer();
    server.once("error", (error) => {
      resume(Effect.fail(error));
    });
    server.listen(port, "127.0.0.1", () => {
      resume(Effect.succeed(server));
    });
    return Effect.void;
  });

const close = (server: Server) =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
    return Effect.void;
  });

/** Occupy an OS-assigned port for the duration of a scoped effect. */
const occupyFreePort = () =>
  Effect.acquireRelease(
    Effect.map(listen(0), (server) => {
      const addr = server.address();
      if (addr == null || typeof addr === "string") {
        throw new Error("Expected TCP server address");
      }
      return { port: addr.port, server };
    }),
    ({ server }) => close(server),
  );

const fakePortProbe = (
  options: {
    readonly unavailable?: ReadonlySet<number>;
    readonly randomPorts?: readonly number[];
  } = {},
) => {
  const unavailable = options.unavailable ?? new Set<number>();
  const randomPorts =
    options.randomPorts ?? Array.from({ length: 100 }, (_, index) => 30001 + index);
  let randomIndex = 0;

  return {
    exact: (port: number) =>
      unavailable.has(port)
        ? Effect.fail(new PortAllocationError({ detail: `Port ${port} is not available` }))
        : Effect.succeed(port),
    random: (exclude: ReadonlySet<number>) =>
      Effect.gen(function* () {
        while (randomIndex < randomPorts.length) {
          const port = randomPorts[randomIndex];
          randomIndex += 1;
          if (port === undefined) {
            continue;
          }
          if (!exclude.has(port) && !unavailable.has(port)) {
            return port;
          }
        }

        return yield* Effect.fail(
          new PortAllocationError({ detail: "No fake random ports available" }),
        );
      }),
  };
};

describe("allocatePorts", () => {
  it("all allocated ports are unique", async () => {
    const ports = await Effect.runPromise(allocatePorts({}, { probe: fakePortProbe() }));
    const values = Object.values(ports) as number[];
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
    for (const port of values) {
      expect(port).toBeGreaterThan(0);
    }
  });

  it("reserved ports are skipped by later allocations", async () => {
    const a = await Effect.runPromise(allocatePorts({}, { probe: fakePortProbe() }));
    const aPorts = new Set(Object.values(a) as number[]);
    const b = await Effect.runPromise(
      allocatePorts({}, { reserved: aPorts, probe: fakePortProbe() }),
    );
    const bPorts = Object.values(b) as number[];

    for (const port of bPorts) {
      expect(aPorts.has(port)).toBe(false);
    }
  });

  it("explicit port is respected when available", async () => {
    const requestedApiPort = 21001;
    const requestedDbPort = 21002;
    const ports = await Effect.runPromise(
      allocatePorts(
        { apiPort: requestedApiPort, dbPort: requestedDbPort },
        { probe: fakePortProbe() },
      ),
    );
    expect(ports.apiPort).toBe(requestedApiPort);
    expect(ports.dbPort).toBe(requestedDbPort);
  });

  it("explicit port that is occupied fails with PortAllocationError", async () => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const occupied = yield* occupyFreePort();

          return yield* allocatePorts({ apiPort: occupied.port }).pipe(Effect.exit);
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("is not available");
    }
  });

  it("preferred ports are reused when available", async () => {
    const apiPort = 21003;
    const dbPort = 21004;
    const studioPort = 21005;
    const ports = await Effect.runPromise(
      allocatePorts(
        {},
        {
          preferred: {
            apiPort,
            dbPort,
            studioPort,
          },
          probe: fakePortProbe(),
        },
      ),
    );

    expect(ports.apiPort).toBe(apiPort);
    expect(ports.dbPort).toBe(dbPort);
    expect(ports.studioPort).toBe(studioPort);
  });

  it("preferred ports fall back to random ports when unavailable", async () => {
    const apiPort = 21006;
    const dbPort = 21007;
    const ports = await Effect.runPromise(
      allocatePorts(
        {},
        {
          preferred: {
            apiPort,
            dbPort,
          },
          probe: fakePortProbe({
            unavailable: new Set([apiPort]),
            randomPorts: Array.from({ length: 20 }, (_, index) => 31001 + index),
          }),
        },
      ),
    );

    expect(ports.apiPort).toBe(31001);
    expect(ports.dbPort).toBe(dbPort);
  });

  it("explicit ports cannot override reserved ownership", async () => {
    const exit = await Effect.runPromise(
      allocatePorts(
        { apiPort: 22001 },
        {
          reserved: new Set([22001]),
        },
      ).pipe(Effect.exit),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("Port 22001 is not available");
    }
  });

  it("preferred ports skip reserved ownership and use random fallback", async () => {
    const ports = await Effect.runPromise(
      allocatePorts(
        {},
        {
          preferred: {
            ...DEFAULT_PORTS,
            apiPort: 23001,
          },
          reserved: new Set([23001]),
          probe: fakePortProbe(),
        },
      ),
    );

    expect(ports.apiPort).not.toBe(23001);
    expect(ports.dbPort).toBe(DEFAULT_PORTS.dbPort);
  });
});
