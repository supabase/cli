import { describe, expect, it } from "@effect/vitest";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { Effect } from "effect";
import { allocatePorts } from "./PortAllocator.ts";

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
  it.live("all allocated ports are unique", () =>
    Effect.gen(function* () {
      const ports = yield* allocatePorts({});
      const values = Object.values(ports) as number[];
      const unique = new Set(values);
      expect(unique.size).toBe(values.length);
      for (const port of values) {
        expect(port).toBeGreaterThan(0);
      }
    }),
  );

  it.live("sequential allocations return non-overlapping ports", () =>
    Effect.gen(function* () {
      const a = yield* allocatePorts({});
      const b = yield* allocatePorts({});

      const aPorts = new Set(Object.values(a) as number[]);
      const bPorts = Object.values(b) as number[];

      for (const port of bPorts) {
        expect(aPorts.has(port)).toBe(false);
      }
    }),
  );

  it.live("explicit port is respected when available", () =>
    Effect.gen(function* () {
      const ports = yield* allocatePorts({ apiPort: 19876, dbPort: 19877 });
      expect(ports.apiPort).toBe(19876);
      expect(ports.dbPort).toBe(19877);
    }),
  );

  it.live("explicit port that is occupied fails with PortAllocationError", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* occupyPort(19888);

        const exit = yield* allocatePorts({ apiPort: 19888 }).pipe(Effect.exit);
        expect(exit._tag).toBe("Failure");
        if (exit._tag === "Failure") {
          const error = exit.cause;
          // The cause should contain a PortAllocationError
          expect(JSON.stringify(error)).toContain("Port 19888 is not available");
        }
      }),
    ),
  );
});
