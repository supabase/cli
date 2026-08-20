import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { allocatePortSet, reservePortSet, type PortReservationRequest } from "./PortAllocator.ts";

const PORT_LEASE_CHILD = resolve(import.meta.dirname, "../tests/helpers/port-lease-child.ts");

interface ChildLease {
  readonly process: ChildProcessWithoutNullStreams;
  readonly ready: Promise<{ readonly apiPort: number; readonly dbPort: number }>;
}

const startChildLease = (): ChildLease => {
  const child = spawn("bun", ["run", PORT_LEASE_CHILD], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const ready = new Promise<{ readonly apiPort: number; readonly dbPort: number }>(
    (resolveReady, rejectReady) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        stdout += chunk.toString();
        const newline = stdout.indexOf("\n");
        if (newline === -1) return;
        settled = true;
        try {
          resolveReady(JSON.parse(stdout.slice(0, newline)));
        } catch (error) {
          rejectReady(new Error(`Invalid child lease response: ${stdout}`, { cause: error }));
        }
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        rejectReady(error);
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        rejectReady(
          new Error(`Port lease child exited with code ${code} before readiness: ${stderr}`),
        );
      });
    },
  );

  return { process: child, ready };
};

const releaseChildLease = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.stdin.end("release\n");
  await closed;
};

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
      const unavailableWhileLeaseIsActive = await Effect.runPromise(
        allocatePortSet([
          { field: "apiPort", selection: { kind: "exact", port: lease.ports.apiPort! } },
        ]).pipe(Effect.exit),
      );
      expect(unavailableWhileLeaseIsActive._tag).toBe("Failure");

      await Effect.runPromise(lease.reserve(["apiPort"]));
      const unavailableAgain = await Effect.runPromise(
        allocatePortSet([
          { field: "apiPort", selection: { kind: "exact", port: lease.ports.apiPort! } },
        ]).pipe(Effect.exit),
      );
      expect(unavailableAgain._tag).toBe("Failure");

      await Effect.runPromise(lease.releaseAll);
    } finally {
      await Effect.runPromise(lease.releaseAll);
    }
  });

  it("keeps an automatically selected port claimed after releasing its reservation", async () => {
    const lease = await Effect.runPromise(
      reservePortSet([{ field: "apiPort", selection: { kind: "automatic", preferred: 0 } }]),
    );
    const port = lease.ports.apiPort;

    try {
      expect(port).toBeGreaterThan(0);

      await Effect.runPromise(lease.release(["apiPort"]));
      const unavailable = await Effect.runPromise(
        allocatePortSet([{ field: "apiPort", selection: { kind: "exact", port: port! } }]).pipe(
          Effect.exit,
        ),
      );
      expect(unavailable._tag).toBe("Failure");
    } finally {
      await Effect.runPromise(lease.releaseAll);
    }

    const available = await Effect.runPromise(
      allocatePortSet([{ field: "apiPort", selection: { kind: "exact", port: port! } }]),
    );
    expect(available.apiPort).toBe(port);
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

  it("rejects zero for an exact port selection", async () => {
    const exit = await Effect.runPromise(
      allocatePortSet([{ field: "apiPort", selection: { kind: "exact", port: 0 } }]).pipe(
        Effect.exit,
      ),
    );

    expect(exit._tag).toBe("Failure");
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

  it("keeps automatic ports disjoint across processes", async () => {
    const firstChild = startChildLease();
    const secondChild = startChildLease();
    const children = [firstChild, secondChild];

    try {
      const [first, second] = await Promise.all([firstChild.ready, secondChild.ready]);
      const ports = [first.apiPort, first.dbPort, second.apiPort, second.dbPort];
      expect(new Set(ports).size).toBe(ports.length);

      for (const port of ports) {
        const unavailable = await Effect.runPromise(
          allocatePortSet([{ field: "apiPort", selection: { kind: "exact", port } }]).pipe(
            Effect.exit,
          ),
        );
        expect(unavailable._tag).toBe("Failure");
      }
    } finally {
      await Promise.all(children.map(({ process }) => releaseChildLease(process)));
    }
  }, 30_000);

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
