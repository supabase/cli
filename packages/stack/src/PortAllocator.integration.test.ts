import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { allocatePortSet, reservePortSet, type PortReservationRequest } from "./PortAllocator.ts";

const listen = (port: number) =>
  Effect.callback<Server, Error>((resume) => {
    const server = createServer();
    server.once("error", (error) => resume(Effect.fail(error)));
    server.listen(port, "127.0.0.1", () => resume(Effect.succeed(server)));
    return Effect.void;
  });

const close = (server: Server) =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
    return Effect.void;
  });

const occupyFreePort = () =>
  Effect.acquireRelease(
    Effect.map(listen(0), (server) => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected TCP server address");
      }
      return { port: address.port, server };
    }),
    ({ server }) => close(server),
  );

const automatic = (field: PortReservationRequest["field"]): PortReservationRequest => ({
  field,
  selection: { kind: "automatic" },
});

describe("selected-field port allocation", () => {
  it("holds only requested fields and can release and re-reserve them", async () => {
    const lease = await Effect.runPromise(
      reservePortSet([automatic("apiPort"), automatic("dbPort")]),
    );

    try {
      expect(lease.ports.apiPort).toBeGreaterThan(0);
      expect(lease.ports.dbPort).toBeGreaterThan(0);
      expect("authPort" in lease.ports).toBe(false);

      const unavailable = await Effect.runPromise(
        allocatePortSet([
          { field: "apiPort", selection: { kind: "exact", port: lease.ports.apiPort! } },
        ]).pipe(Effect.exit),
      );
      expect(unavailable._tag).toBe("Failure");

      await Effect.runPromise(lease.release(["apiPort"]));
      const rebound = await Effect.runPromise(
        allocatePortSet([
          { field: "apiPort", selection: { kind: "exact", port: lease.ports.apiPort! } },
        ]),
      );
      expect(rebound.apiPort).toBe(lease.ports.apiPort);

      await Effect.runPromise(lease.reserve(["apiPort"]));
      const unavailableAgain = await Effect.runPromise(
        allocatePortSet([
          { field: "apiPort", selection: { kind: "exact", port: lease.ports.apiPort! } },
        ]).pipe(Effect.exit),
      );
      expect(unavailableAgain._tag).toBe("Failure");

      await Effect.runPromise(lease.releaseAll);
      const reboundBoth = await Effect.runPromise(
        allocatePortSet([
          { field: "apiPort", selection: { kind: "exact", port: lease.ports.apiPort! } },
          { field: "dbPort", selection: { kind: "exact", port: lease.ports.dbPort! } },
        ]),
      );
      expect(reboundBoth.apiPort).toBe(lease.ports.apiPort);
      expect(reboundBoth.dbPort).toBe(lease.ports.dbPort);
    } finally {
      await Effect.runPromise(lease.releaseAll);
    }
  });

  it("fails when an exact port is occupied", async () => {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const occupied = yield* occupyFreePort();
          return yield* allocatePortSet([
            { field: "apiPort", selection: { kind: "exact", port: occupied.port } },
          ]).pipe(Effect.exit);
        }),
      ),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("is not available");
    }
  });

  it("keeps concurrent selected-field leases disjoint", async () => {
    const [first, second] = await Promise.all([
      Effect.runPromise(reservePortSet([automatic("apiPort"), automatic("dbPort")])),
      Effect.runPromise(reservePortSet([automatic("apiPort"), automatic("dbPort")])),
    ]);

    try {
      const firstPorts = new Set(Object.values(first.ports));
      expect(Object.values(second.ports).every((port) => !firstPorts.has(port))).toBe(true);
    } finally {
      await Promise.all([
        Effect.runPromise(first.releaseAll),
        Effect.runPromise(second.releaseAll),
      ]);
    }
  });

  it("releases partial reservations when a selected set fails", async () => {
    const firstPort = await Effect.runPromise(
      Effect.scoped(Effect.map(occupyFreePort(), (occupied) => occupied.port)),
    );
    const failed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const occupied = yield* occupyFreePort();
          return yield* reservePortSet([
            { field: "apiPort", selection: { kind: "exact", port: firstPort } },
            { field: "dbPort", selection: { kind: "exact", port: occupied.port } },
          ]).pipe(Effect.exit);
        }),
      ),
    );
    expect(failed._tag).toBe("Failure");

    const available = await Effect.runPromise(
      allocatePortSet([{ field: "apiPort", selection: { kind: "exact", port: firstPort } }]),
    );
    expect(available.apiPort).toBe(firstPort);
  });

  it("releases a bound port when interrupted during lease registration", async () => {
    const port = await Effect.runPromise(
      Effect.scoped(Effect.map(occupyFreePort(), (occupied) => occupied.port)),
    );
    const interrupted = await Effect.runPromise(
      reservePortSet([{ field: "apiPort", selection: { kind: "exact", port } }], {
        onBound: () => Effect.interrupt,
      }).pipe(Effect.exit),
    );
    expect(interrupted._tag).toBe("Failure");

    const rebound = await Effect.runPromise(
      allocatePortSet([{ field: "apiPort", selection: { kind: "exact", port } }]),
    );
    expect(rebound.apiPort).toBe(port);
  });
});
