import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { Effect } from "effect";
import { allocatePorts, DEFAULT_PORTS } from "./PortAllocator.ts";

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

const getFreePort = () =>
  Effect.acquireUseRelease(
    listen(0),
    (server) =>
      Effect.sync(() => {
        const addr = server.address();
        if (addr == null || typeof addr === "string") {
          throw new Error("Expected TCP server address");
        }
        return addr.port;
      }),
    close,
  );

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

describe("allocatePorts", () => {
  it("all allocated ports are unique", async () => {
    const ports = await Effect.runPromise(allocatePorts({}));
    const values = Object.values(ports) as number[];
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
    for (const port of values) {
      expect(port).toBeGreaterThan(0);
    }
  });

  it("reserved ports are skipped by later allocations", async () => {
    const a = await Effect.runPromise(allocatePorts({}));
    const aPorts = new Set(Object.values(a) as number[]);
    const b = await Effect.runPromise(allocatePorts({}, { reserved: aPorts }));
    const bPorts = Object.values(b) as number[];

    for (const port of bPorts) {
      expect(aPorts.has(port)).toBe(false);
    }
  });

  it("explicit port is respected when available", async () => {
    const requestedApiPort = await Effect.runPromise(getFreePort());
    const requestedDbPort = await Effect.runPromise(getFreePort());
    const ports = await Effect.runPromise(
      allocatePorts({ apiPort: requestedApiPort, dbPort: requestedDbPort }),
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
    const apiPort = await Effect.runPromise(getFreePort());
    const dbPort = await Effect.runPromise(getFreePort());
    const studioPort = await Effect.runPromise(getFreePort());
    const ports = await Effect.runPromise(
      allocatePorts(
        {},
        {
          preferred: {
            apiPort,
            dbPort,
            studioPort,
          },
        },
      ),
    );

    expect(ports.apiPort).toBe(apiPort);
    expect(ports.dbPort).toBe(dbPort);
    expect(ports.studioPort).toBe(studioPort);
  });

  it("preferred ports fall back to random ports when unavailable", async () => {
    const dbPort = await Effect.runPromise(getFreePort());
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const occupied = yield* occupyFreePort();

          return yield* allocatePorts(
            {},
            {
              preferred: {
                apiPort: occupied.port,
                dbPort,
              },
            },
          );
        }),
      ),
    );

    expect(exit.apiPort).not.toBe(exit.dbPort);
    expect(exit.dbPort).toBe(dbPort);
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
        },
      ),
    );

    expect(ports.apiPort).not.toBe(23001);
    expect(ports.dbPort).toBe(DEFAULT_PORTS.dbPort);
  });
});
