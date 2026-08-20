import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Cause, Effect, Exit, FileSystem } from "effect";
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

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));

const claimRoot = resolve(
  tmpdir(),
  `supabase-stack-port-claims-${
    process.getuid?.() === undefined
      ? `user-${process.env.USER ?? "unknown"}`
      : `uid-${process.getuid()}`
  }`,
);

const claimPath = (port: number) => resolve(claimRoot, `port-${port}`);

const staleClaim = (port: number, token: string) => {
  mkdirSync(claimRoot, { recursive: true });
  const path = claimPath(port);
  writeFileSync(path, JSON.stringify({ pid: 999_999_999, token }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(path, old, old);
  return path;
};

const withFileSystem = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
  customize: (fs: FileSystem.FileSystem) => FileSystem.FileSystem,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* effect.pipe(Effect.provideService(FileSystem.FileSystem, customize(fs)));
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

describe("selected-field port allocation", () => {
  it("requires an Effect FileSystem service for claim inspection", async () => {
    const exit = await Effect.runPromise(
      // @ts-expect-error This red contract intentionally omits the required service.
      allocatePortSet([{ field: "apiPort", selection: { kind: "exact", port: 25_901 } }]).pipe(
        Effect.exit,
      ),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("reclaims a stale claim before probing an exact port", async () => {
    const port = 25_951;
    const path = staleClaim(port, "stale-recovery");

    try {
      const ports = await run(
        allocatePortSet([{ field: "apiPort", selection: { kind: "exact", port } }]),
      );
      expect(ports.apiPort).toBe(port);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("does not delete a fresh replacement while reclaimers race", async () => {
    const port = 25_952;
    const path = staleClaim(port, "stale-race");
    let raced = false;

    try {
      const exit = await withFileSystem(
        allocatePortSet([{ field: "apiPort", selection: { kind: "exact", port } }]).pipe(
          Effect.exit,
        ),
        (fs) => ({
          ...fs,
          rename: (from, to) =>
            Effect.gen(function* () {
              if (!raced && from === path) {
                raced = true;
                yield* fs.rename(from, `${from}.competing`);
                yield* fs.writeFileString(
                  from,
                  JSON.stringify({ pid: process.pid, token: "fresh" }),
                );
              }
              yield* fs.rename(from, to);
            }),
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.findErrorOption(exit.cause)).toMatchObject({
          _tag: "Some",
          value: { _tag: "PortAllocationError", port },
        });
      }
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
        pid: process.pid,
        token: "fresh",
      });
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}.competing`, { force: true });
    }
  });

  it("removes a claim file when creation is interrupted during the write", async () => {
    const port = 25_953;
    const path = claimPath(port);
    rmSync(path, { force: true });

    try {
      const exit = await withFileSystem(
        reservePortSet([{ field: "apiPort", selection: { kind: "exact", port } }]).pipe(
          Effect.exit,
        ),
        (fs) => ({
          ...fs,
          open: (filePath, options) =>
            fs.open(filePath, options).pipe(
              Effect.map((handle) => ({
                ...handle,
                stat: handle.stat,
                writeAll: () => Effect.interrupt,
              })),
            ),
        }),
      );

      expect(exit._tag).toBe("Failure");
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("closes a random bind when claim acquisition is interrupted", async () => {
    let interruptedPort: number | undefined;

    const exit = await withFileSystem(
      reservePortSet([{ field: "apiPort", selection: { kind: "automatic" } }]).pipe(Effect.exit),
      (fs) => ({
        ...fs,
        open: (path) => {
          interruptedPort = Number(path.slice(path.lastIndexOf("-") + 1));
          return Effect.interrupt;
        },
      }),
    );

    expect(exit._tag).toBe("Failure");
    expect(interruptedPort).toBeGreaterThan(0);
    const reboundExit = await run(
      reservePortSet([
        { field: "apiPort", selection: { kind: "exact", port: interruptedPort! } },
      ]).pipe(Effect.exit),
    );
    expect(reboundExit._tag).toBe("Success");
    if (reboundExit._tag === "Success") await run(reboundExit.value.releaseAll);
  });

  it("holds only requested fields and can release and re-reserve them", async () => {
    const lease = await run(reservePortSet([automatic("apiPort"), automatic("dbPort")]));

    try {
      expect(lease.ports.apiPort).toBeGreaterThan(0);
      expect(lease.ports.dbPort).toBeGreaterThan(0);
      expect("authPort" in lease.ports).toBe(false);

      const unavailable = await run(
        allocatePortSet([
          { field: "apiPort", selection: { kind: "exact", port: lease.ports.apiPort! } },
        ]).pipe(Effect.exit),
      );
      expect(unavailable._tag).toBe("Failure");

      await run(lease.release(["apiPort"]));
      const unavailableWhileLeaseIsActive = await run(
        allocatePortSet([
          { field: "apiPort", selection: { kind: "exact", port: lease.ports.apiPort! } },
        ]).pipe(Effect.exit),
      );
      expect(unavailableWhileLeaseIsActive._tag).toBe("Failure");

      await run(lease.reserve(["apiPort"]));
      const unavailableAgain = await run(
        allocatePortSet([
          { field: "apiPort", selection: { kind: "exact", port: lease.ports.apiPort! } },
        ]).pipe(Effect.exit),
      );
      expect(unavailableAgain._tag).toBe("Failure");

      await run(lease.releaseAll);
    } finally {
      await run(lease.releaseAll);
    }
  });

  it("keeps an automatically selected port claimed after releasing its reservation", async () => {
    const lease = await run(
      reservePortSet([{ field: "apiPort", selection: { kind: "automatic", preferred: 0 } }]),
    );
    const port = lease.ports.apiPort;

    try {
      expect(port).toBeGreaterThan(0);

      await run(lease.release(["apiPort"]));
      const unavailable = await run(
        allocatePortSet([{ field: "apiPort", selection: { kind: "exact", port: port! } }]).pipe(
          Effect.exit,
        ),
      );
      expect(unavailable._tag).toBe("Failure");
    } finally {
      await run(lease.releaseAll);
    }

    const available = await run(
      allocatePortSet([{ field: "apiPort", selection: { kind: "exact", port: port! } }]),
    );
    expect(available.apiPort).toBe(port);
  });

  it("fails when an exact port is occupied", async () => {
    const exit = await run(
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
    const exit = await run(
      allocatePortSet([{ field: "apiPort", selection: { kind: "exact", port: 0 } }]).pipe(
        Effect.exit,
      ),
    );

    expect(exit._tag).toBe("Failure");
  });

  it("keeps concurrent selected-field leases disjoint", async () => {
    const [first, second] = await Promise.all([
      run(reservePortSet([automatic("apiPort"), automatic("dbPort")])),
      run(reservePortSet([automatic("apiPort"), automatic("dbPort")])),
    ]);

    try {
      const firstPorts = new Set(Object.values(first.ports));
      expect(Object.values(second.ports).every((port) => !firstPorts.has(port))).toBe(true);
    } finally {
      await Promise.all([run(first.releaseAll), run(second.releaseAll)]);
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
        const unavailable = await run(
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
    const firstPort = await run(
      Effect.scoped(Effect.map(occupyFreePort(), (occupied) => occupied.port)),
    );
    const failed = await run(
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

    const available = await run(
      allocatePortSet([{ field: "apiPort", selection: { kind: "exact", port: firstPort } }]),
    );
    expect(available.apiPort).toBe(firstPort);
  });

  it("releases a bound port when interrupted during lease registration", async () => {
    const port = await run(
      Effect.scoped(Effect.map(occupyFreePort(), (occupied) => occupied.port)),
    );
    const interrupted = await run(
      reservePortSet([{ field: "apiPort", selection: { kind: "exact", port } }], {
        onBound: () => Effect.interrupt,
      }).pipe(Effect.exit),
    );
    expect(interrupted._tag).toBe("Failure");

    const rebound = await run(
      allocatePortSet([{ field: "apiPort", selection: { kind: "exact", port } }]),
    );
    expect(rebound.apiPort).toBe(port);
  });
});
