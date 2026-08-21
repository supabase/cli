import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { reservePortSet, type PortReservationRequest } from "./PortAllocator.ts";

const exact = (field: PortReservationRequest["field"], port: number): PortReservationRequest => ({
  field,
  selection: { kind: "exact", port },
});

const automatic = (field: PortReservationRequest["field"]): PortReservationRequest => ({
  field,
  selection: { kind: "automatic" },
});

const listen = (port: number) =>
  Effect.callback<Server, Error>((resume) => {
    const server = createServer();
    const onError = (error: Error) => resume(Effect.fail(error));
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      resume(Effect.succeed(server));
    });
    return Effect.sync(() => {
      server.off("error", onError);
      if (server.listening) server.close();
    });
  });

const close = (server: Server) =>
  Effect.callback<void>((resume) => {
    if (!server.listening) {
      resume(Effect.void);
      return Effect.void;
    }
    server.close(() => resume(Effect.void));
    return Effect.void;
  });

describe("port ownership", () => {
  it("keeps leased sockets unavailable to competing listeners", async () => {
    const lease = await Effect.runPromise(
      reservePortSet([automatic("apiPort"), automatic("dbPort")]),
    );
    const apiPort = lease.ports.apiPort;
    if (apiPort === undefined) throw new Error("automatic allocation returned no api port");
    expect(apiPort).toBeGreaterThan(0);

    try {
      const occupied = await Effect.runPromise(listen(apiPort).pipe(Effect.exit));
      expect(Exit.isFailure(occupied)).toBe(true);
    } finally {
      await Effect.runPromise(lease.releaseAll);
    }
  });

  it("allocates disjoint sockets for concurrent leases", async () => {
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

  it("rejects an exact request while an external listener remains held", async () => {
    const occupied = await Effect.runPromise(listen(0));
    const address = occupied.address();
    if (address === null || typeof address === "string") throw new Error("missing port");

    const failed = await Effect.runPromise(
      reservePortSet([
        { field: "apiPort", selection: { kind: "automatic" } },
        exact("dbPort", address.port),
      ]).pipe(Effect.exit),
    );
    expect(Exit.isFailure(failed)).toBe(true);
    expect(occupied.listening).toBe(true);
    await Effect.runPromise(close(occupied));
  });
});
