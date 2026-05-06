import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { Effect } from "effect";
import { allocatePorts, DEFAULT_PORTS } from "./PortAllocator.ts";

/** Occupy a port for the duration of a scoped effect. */
const occupyPort = (port: number) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createServer();
      server.listen(port, "127.0.0.1", () => {
        resume(Effect.succeed(server));
      });
      server.on("error", () => {
        resume(Effect.succeed(server));
      });
      return Effect.void;
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        return Effect.void;
      }),
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
    const ports = await Effect.runPromise(allocatePorts({ apiPort: 19876, dbPort: 19877 }));
    expect(ports.apiPort).toBe(19876);
    expect(ports.dbPort).toBe(19877);
  });

  it("explicit port that is occupied fails with PortAllocationError", async () => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* occupyPort(19888);

          return yield* allocatePorts({ apiPort: 19888 }).pipe(Effect.exit);
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("Port 19888 is not available");
    }
  });

  it("preferred ports are reused when available", async () => {
    const ports = await Effect.runPromise(
      allocatePorts(
        {},
        {
          preferred: {
            apiPort: 21001,
            dbPort: 21002,
            studioPort: 21003,
          },
        },
      ),
    );

    expect(ports.apiPort).toBe(21001);
    expect(ports.dbPort).toBe(21002);
    expect(ports.studioPort).toBe(21003);
  });

  it("preferred ports fall back to random ports when unavailable", async () => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* occupyPort(21011);

          return yield* allocatePorts(
            {},
            {
              preferred: {
                apiPort: 21011,
                dbPort: 21012,
              },
            },
          );
        }),
      ),
    );

    expect(exit.apiPort).not.toBe(21011);
    expect(exit.dbPort).toBe(21012);
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
