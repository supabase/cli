// oxlint-disable effecttsgo/async-function, effecttsgo/global-error-in-effect-failure, effecttsgo/global-timers-in-effect, effecttsgo/new-promise, effecttsgo/node-builtin-import -- Tests intentionally exercise native async, HTTP, timer, and subprocess boundaries.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Cause, Effect, Exit, FileSystem } from "effect";
import { reservePortSet, type PortReservationRequest } from "./PortAllocator.ts";

const PORT_LEASE_CHILD = resolve(import.meta.dirname, "../tests/helpers/port-lease-child.ts");
const STACK_PACKAGE_ROOT = resolve(import.meta.dirname, "..");

const INTERRUPTED_ALLOCATION_SCRIPT = `
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Fiber } from "effect";
import { reservePortSet } from "./src/PortAllocator.ts";

const fiber = Effect.runFork(
  reservePortSet([{ field: "apiPort", selection: { kind: "automatic" } }]).pipe(
    Effect.provide(NodeFileSystem.layer),
  ),
);
await Effect.runPromise(
  Effect.callback((resume) => queueMicrotask(() => resume(Effect.void))),
);
await Effect.runPromise(Fiber.interrupt(fiber));
`;

const interruptedAllocationExits = (runtime: "node" | "bun"): Effect.Effect<void, Error> =>
  Effect.callback<void, Error>((resume) => {
    const args =
      runtime === "node"
        ? ["--input-type=module", "-e", INTERRUPTED_ALLOCATION_SCRIPT]
        : ["-e", INTERRUPTED_ALLOCATION_SCRIPT];
    const child = spawn(runtime, args, {
      cwd: STACK_PACKAGE_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let settled = false;
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const finish = (effect: Effect.Effect<void, Error>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resume(effect);
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        Effect.fail(
          new Error(`${runtime} retained a listener after interrupted allocation: ${stderr}`),
        ),
      );
    }, 5_000);
    child.once("error", (error) => finish(Effect.fail(error)));
    child.once("close", (code, signal) =>
      finish(
        code === 0
          ? Effect.void
          : Effect.fail(
              new Error(`${runtime} allocator probe exited with ${code ?? signal}: ${stderr}`),
            ),
      ),
    );
    return Effect.sync(() => {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
  });

const automatic = (field: PortReservationRequest["field"]): PortReservationRequest => ({
  field,
  selection: { kind: "automatic" },
});

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)));

const occupyFreePort = () =>
  Effect.acquireRelease(
    Effect.callback<Server, Error>((resume) => {
      const server = createServer();
      server.once("error", (error) => resume(Effect.fail(error)));
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      return Effect.sync(() => server.close());
    }).pipe(
      Effect.map((server) => {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Expected address");
        return { port: address.port, server };
      }),
    ),
    ({ server }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        return Effect.void;
      }),
  );

const startChildLease = () => {
  const child = spawn("bun", ["run", PORT_LEASE_CHILD], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const ready = new Promise<{ readonly apiPort: number; readonly dbPort: number }>(
    (resolveReady, rejectReady) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const newline = stdout.indexOf("\n");
        if (newline === -1) return;
        try {
          resolveReady(JSON.parse(stdout.slice(0, newline)));
        } catch (error) {
          rejectReady(new Error(`Invalid child response: ${stdout}`, { cause: error }));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.once("error", rejectReady);
      child.once("close", (code) => {
        rejectReady(new Error(`Child exited before readiness (${code}): ${stderr}`));
      });
    },
  );
  return { child, ready };
};

describe("reservePortSet", () => {
  it.each(["node", "bun"] as const)(
    "closes a pending listener when allocation is interrupted under %s",
    async (runtime) => {
      await Effect.runPromise(interruptedAllocationExits(runtime));
    },
    10_000,
  );

  it("fails an occupied exact port with field and port attribution", async () => {
    let occupiedPort = 0;
    const exit = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const occupied = yield* occupyFreePort();
          occupiedPort = occupied.port;
          return yield* reservePortSet([
            { field: "apiPort", selection: { kind: "exact", port: occupied.port } },
          ]).pipe(Effect.exit);
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      expect(error).toMatchObject({ field: "apiPort", port: occupiedPort });
    }
  });

  it("reserves multiple automatic fields and re-reserves selected fields", async () => {
    const lease = await run(reservePortSet([automatic("apiPort"), automatic("dbPort")]));
    try {
      expect(lease.ports.apiPort).toBeGreaterThan(0);
      expect(lease.ports.dbPort).toBeGreaterThan(0);
      await run(lease.release(["dbPort"]));
      await run(lease.reserve(["dbPort"]));
    } finally {
      await run(lease.releaseAll);
    }
  });

  it("retains claims after TCP release until releaseAll", async () => {
    const lease = await run(reservePortSet([automatic("apiPort")]));
    const port = lease.ports.apiPort;
    if (port === undefined) throw new Error("Expected API port");
    try {
      await run(lease.release(["apiPort"]));
      const blocked = await run(
        reservePortSet([{ field: "apiPort", selection: { kind: "exact", port } }]).pipe(
          Effect.exit,
        ),
      );
      expect(Exit.isFailure(blocked)).toBe(true);
    } finally {
      await run(lease.releaseAll);
    }
  });

  it("keeps automatic ports disjoint across child processes", async () => {
    const first = startChildLease();
    const second = startChildLease();
    try {
      const [left, right] = await Promise.all([first.ready, second.ready]);
      const ports = [left.apiPort, left.dbPort, right.apiPort, right.dbPort];
      expect(new Set(ports).size).toBe(ports.length);
    } finally {
      for (const child of [first.child, second.child]) {
        if (child.exitCode === null) {
          child.stdin.end("release\n");
          await once(child, "close");
        }
      }
    }
  }, 30_000);

  it("recovers a stale claim left by an unclean child exit", async () => {
    const child = startChildLease();
    const ports = await child.ready;
    child.child.kill("SIGKILL");
    await once(child.child, "close");
    const lease = await run(
      reservePortSet([{ field: "apiPort", selection: { kind: "exact", port: ports.apiPort } }]),
    );
    await run(lease.releaseAll);
  }, 30_000);

  it("rolls back earlier fields when a later exact field is unavailable", async () => {
    const failed = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const occupied = yield* occupyFreePort();
          return yield* reservePortSet([
            automatic("apiPort"),
            { field: "dbPort", selection: { kind: "exact", port: occupied.port } },
          ]).pipe(Effect.exit);
        }),
      ),
    );
    expect(Exit.isFailure(failed)).toBe(true);
    const retry = await run(reservePortSet([automatic("apiPort")]));
    await run(retry.releaseAll);
  });
});
