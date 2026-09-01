// oxlint-disable effecttsgo/async-function, effecttsgo/global-error-in-effect-failure, effecttsgo/global-timers-in-effect, effecttsgo/new-promise, effecttsgo/node-builtin-import -- Port allocation tests drive native TCP listeners and child processes, including intentionally pending callbacks and process errors.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Cause, Effect, Exit, FileSystem } from "effect";
import {
  PortAllocationError,
  reservePortSet,
  type PortReservationRequest,
} from "./PortAllocator.ts";

const PORT_LEASE_CHILD = resolve(import.meta.dirname, "../tests/helpers/port-lease-child.ts");
const STACK_PACKAGE_ROOT = resolve(import.meta.dirname, "..");

const INTERRUPTED_ALLOCATION_SCRIPT = `
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Fiber } from "effect";
import { Server } from "node:net";

let markBound;
const bound = new Promise((resolve) => {
  markBound = resolve;
});
const originalListen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  if (typeof args.at(-1) === "function") args.pop();
  return originalListen.call(this, ...args, () => {
    Server.prototype.listen = originalListen;
    markBound();
  });
};

const { reservePortSet } = await import("./src/PortAllocator.ts");

const fiber = Effect.runFork(
  reservePortSet(
    [{ field: "apiPort", selection: { kind: "automatic" } }],
    { mode: "native" },
  ).pipe(
    Effect.provide(NodeFileSystem.layer),
  ),
);
await bound;
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
    }, 20_000);
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

const MAX_PG_META_COLLISION_ATTEMPTS = 32;

type PgMetaCollisionAttempt =
  | { readonly kind: "retry"; readonly detail: string }
  | {
      readonly kind: "collision";
      readonly adminPort: number;
      readonly basePort: number;
      readonly error: PortAllocationError;
    }
  | {
      readonly kind: "unexpected";
      readonly adminPort: number;
      readonly basePort: number;
      readonly error: unknown;
    }
  | {
      readonly kind: "unexpected-success";
      readonly adminPort: number;
      readonly basePort: number;
    };

/**
 * Keep the candidate admin listener owned while reservePortSet probes the
 * exact PgMeta span. A base-port collision is retried with a fresh candidate;
 * the scoped listener is closed before the next candidate is selected.
 */
const probePgMetaAdminCollision = (): Effect.Effect<
  PgMetaCollisionAttempt,
  Error,
  FileSystem.FileSystem
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const occupied = yield* occupyFreePort();
      const adminPort = occupied.port;
      if (adminPort < 2 || adminPort > 65_535) {
        return {
          kind: "retry",
          detail: `Ephemeral admin candidate ${adminPort} cannot form a valid PgMeta span`,
        } as const;
      }
      const basePort = adminPort - 1;
      const exit = yield* reservePortSet(
        [{ field: "pgmetaPort", selection: { kind: "exact", port: basePort } }],
        { mode: "native" },
      ).pipe(Effect.exit);
      if (Exit.isSuccess(exit)) {
        yield* exit.value.releaseAll;
        return { kind: "unexpected-success", adminPort, basePort } as const;
      }
      const error = Cause.squash(exit.cause);
      if (
        error instanceof PortAllocationError &&
        error.field === "pgmetaPort" &&
        error.port === adminPort
      ) {
        return { kind: "collision", adminPort, basePort, error } as const;
      }
      if (
        error instanceof PortAllocationError &&
        error.field === "pgmetaPort" &&
        error.port === basePort
      ) {
        return {
          kind: "retry",
          detail: `PgMeta base ${basePort} was already unavailable`,
        } as const;
      }
      return { kind: "unexpected", adminPort, basePort, error } as const;
    }),
  );

describe("reservePortSet", () => {
  it.each(["node", "bun"] as const)(
    "closes a pending listener when allocation is interrupted under %s",
    async (runtime) => {
      await Effect.runPromise(interruptedAllocationExits(runtime));
    },
    30_000,
  );

  it("fails an occupied exact port with field and port attribution", async () => {
    let occupiedPort = 0;
    const exit = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const occupied = yield* occupyFreePort();
          occupiedPort = occupied.port;
          return yield* reservePortSet(
            [{ field: "apiPort", selection: { kind: "exact", port: occupied.port } }],
            { mode: "native" },
          ).pipe(Effect.exit);
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      expect(error).toMatchObject({
        field: "apiPort",
        port: occupiedPort,
        reason: "unavailable",
      });
    }
  });

  it("reserves multiple automatic fields and re-reserves selected fields", async () => {
    const lease = await run(
      reservePortSet([automatic("apiPort"), automatic("dbPort")], { mode: "native" }),
    );
    try {
      expect(lease.ports.apiPort).toBeGreaterThan(0);
      expect(lease.ports.dbPort).toBeGreaterThan(0);
      await run(lease.release(["dbPort"]));
      await run(lease.reserve(["dbPort"]));
    } finally {
      await run(lease.releaseAll);
    }
  });

  it("keeps native Pooler shard listener spans disjoint across stacks", async () => {
    const first = await run(reservePortSet([automatic("poolerInternalPort")], { mode: "native" }));
    const second = await run(reservePortSet([automatic("poolerInternalPort")], { mode: "native" }));
    try {
      const firstBase = first.ports.poolerInternalPort;
      const secondBase = second.ports.poolerInternalPort;
      if (firstBase === undefined || secondBase === undefined) {
        throw new Error("Expected native Pooler internal port allocations");
      }
      const firstSpan = new Set(Array.from({ length: 8 }, (_, index) => firstBase + index));
      const secondSpan = new Set(Array.from({ length: 8 }, (_, index) => secondBase + index));
      expect([...firstSpan].some((port) => secondSpan.has(port))).toBe(false);
    } finally {
      await run(first.releaseAll);
      await run(second.releaseAll);
    }
  });

  it("keeps the PgMeta admin port out of other automatic allocations", async () => {
    const lease = await run(
      reservePortSet([automatic("pgmetaPort"), automatic("apiPort")], { mode: "native" }),
    );
    try {
      const pgmetaPort = lease.ports.pgmetaPort;
      const apiPort = lease.ports.apiPort;
      if (pgmetaPort === undefined || apiPort === undefined) {
        throw new Error("Expected PgMeta and API ports");
      }
      expect(apiPort).not.toBe(pgmetaPort + 1);
    } finally {
      await run(lease.releaseAll);
    }
  });

  it("rejects an exact PgMeta base when its admin port is already owned", async () => {
    await run(
      Effect.gen(function* () {
        const retries: Array<string> = [];
        for (let attempt = 1; attempt <= MAX_PG_META_COLLISION_ATTEMPTS; attempt += 1) {
          const outcome = yield* probePgMetaAdminCollision();
          if (outcome.kind === "retry") {
            retries.push(outcome.detail);
            continue;
          }
          if (outcome.kind === "collision") {
            expect(outcome.error).toMatchObject({
              field: "pgmetaPort",
              port: outcome.adminPort,
            });
            return;
          }
          if (outcome.kind === "unexpected-success") {
            throw new Error(
              `PgMeta exact allocation unexpectedly succeeded for base ${outcome.basePort} while admin ${outcome.adminPort} was owned`,
            );
          }
          throw new Error(
            `PgMeta exact allocation failed unexpectedly for base ${outcome.basePort} with ${String(outcome.error)}`,
          );
        }
        throw new Error(
          `Unable to obtain a free PgMeta base after ${MAX_PG_META_COLLISION_ATTEMPTS} attempts: ${retries.join("; ")}`,
        );
      }),
    );
  });

  it("allows a Docker PgMeta base when only its native admin port is occupied", async () => {
    await run(
      Effect.gen(function* () {
        for (let attempt = 0; attempt < MAX_PG_META_COLLISION_ATTEMPTS; attempt += 1) {
          const outcome = yield* Effect.scoped(
            Effect.gen(function* () {
              const occupied = yield* occupyFreePort();
              if (occupied.port < 2 || occupied.port > 65_535) return "retry" as const;
              const basePort = occupied.port - 1;
              const exit = yield* reservePortSet(
                [{ field: "pgmetaPort", selection: { kind: "exact", port: basePort } }],
                { mode: "docker" },
              ).pipe(Effect.exit);
              if (Exit.isSuccess(exit)) {
                yield* exit.value.releaseAll;
                return "success" as const;
              }
              const error = Cause.squash(exit.cause);
              if (
                error instanceof PortAllocationError &&
                error.field === "pgmetaPort" &&
                error.port === basePort
              ) {
                return "retry" as const;
              }
              throw new Error(
                `Docker PgMeta exact allocation failed unexpectedly for base ${basePort}: ${String(error)}`,
              );
            }),
          );
          if (outcome === "success") return;
        }
        throw new Error("Unable to obtain a free Docker PgMeta base after repeated attempts");
      }),
    );
  });

  it("keeps Realtime's full native gen_rpc span while Docker uses only its base port", async () => {
    await run(
      Effect.gen(function* () {
        for (let attempt = 0; attempt < MAX_PG_META_COLLISION_ATTEMPTS; attempt += 1) {
          const outcome = yield* Effect.scoped(
            Effect.gen(function* () {
              const occupied = yield* occupyFreePort();
              if (occupied.port < 2 || occupied.port > 65_535) return "retry" as const;
              const basePort = occupied.port - 3;
              const native = yield* reservePortSet(
                [{ field: "realtimePort", selection: { kind: "exact", port: basePort } }],
                { mode: "native" },
              ).pipe(Effect.exit);
              if (Exit.isSuccess(native)) {
                yield* native.value.releaseAll;
                throw new Error(
                  `Native Realtime exact allocation unexpectedly succeeded for base ${basePort} while gen_rpc ${occupied.port} was owned`,
                );
              }
              const error = Cause.squash(native.cause);
              if (
                error instanceof PortAllocationError &&
                error.field === "realtimePort" &&
                error.port !== occupied.port
              ) {
                return "retry" as const;
              }
              if (
                !(error instanceof PortAllocationError) ||
                error.field !== "realtimePort" ||
                error.port !== occupied.port
              ) {
                throw new Error(
                  `Native Realtime exact allocation failed unexpectedly for base ${basePort}: ${String(error)}`,
                );
              }

              const docker = yield* reservePortSet(
                [{ field: "realtimePort", selection: { kind: "exact", port: basePort } }],
                { mode: "docker" },
              ).pipe(Effect.exit);
              if (Exit.isFailure(docker)) {
                throw new Error(
                  `Docker Realtime exact allocation failed while only native span port ${occupied.port} was owned: ${String(Cause.squash(docker.cause))}`,
                );
              }
              yield* docker.value.releaseAll;
              return "success" as const;
            }),
          );
          if (outcome === "success") return;
        }
        throw new Error(
          `Unable to obtain a free Realtime base after repeated span collision attempts`,
        );
      }),
    );
  });

  it("releases every PgMeta listener when releasing its field", async () => {
    const lease = await run(reservePortSet([automatic("pgmetaPort")], { mode: "native" }));
    try {
      await run(lease.release(["pgmetaPort"]));
      // Reusing the same lease retains both ownership claims. Successful
      // re-reservation therefore proves both TCP listeners were released.
      await run(lease.reserve(["pgmetaPort"]));
    } finally {
      await run(lease.releaseAll);
    }
  });

  it("retains claims after TCP release until releaseAll", async () => {
    const lease = await run(reservePortSet([automatic("apiPort")], { mode: "native" }));
    const port = lease.ports.apiPort;
    if (port === undefined) throw new Error("Expected API port");
    try {
      await run(lease.release(["apiPort"]));
      const blocked = await run(
        reservePortSet([{ field: "apiPort", selection: { kind: "exact", port } }], {
          mode: "native",
        }).pipe(Effect.exit),
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
      reservePortSet([{ field: "apiPort", selection: { kind: "exact", port: ports.apiPort } }], {
        mode: "native",
      }),
    );
    await run(lease.releaseAll);
  }, 30_000);

  it("rolls back earlier fields when a later exact field is unavailable", async () => {
    const failed = await run(
      Effect.scoped(
        Effect.gen(function* () {
          const occupied = yield* occupyFreePort();
          return yield* reservePortSet(
            [
              automatic("apiPort"),
              { field: "dbPort", selection: { kind: "exact", port: occupied.port } },
            ],
            { mode: "native" },
          ).pipe(Effect.exit);
        }),
      ),
    );
    expect(Exit.isFailure(failed)).toBe(true);
    const retry = await run(reservePortSet([automatic("apiPort")], { mode: "native" }));
    await run(retry.releaseAll);
  });
});
