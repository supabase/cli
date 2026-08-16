import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context, Deferred, Effect, Fiber, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
import type { ManagedPortPlan } from "./managed/port-plan.ts";
import {
  ManagedPortCoordinator,
  type ManagedPortStartAllocation,
} from "./managed/port-coordinator.ts";
import type { ManagedStackRecord } from "./managed/model.ts";
import { ManagedPortReservationError } from "./managed/model.ts";
import type {
  ClaimManagedStartPortsInput,
  ManagedPortReservation,
  ManagedStackRepositoryShape,
} from "./managed/repository.ts";
import { reservePortSet } from "./PortAllocator.ts";
import { createInMemoryManagedStackRepository } from "./managed/repository-memory.ts";
import { ManagedStackRepository } from "./managed/repository.ts";
import { sqliteManagedStackRepositoryLayer, type ManagedSqliteDatabase } from "./managed/sqlite.ts";

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a numeric loopback address");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
};

const occupiedPort = async (): Promise<{
  readonly port: number;
  readonly close: () => Promise<void>;
}> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a numeric loopback address");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
};

const stack = (): ManagedStackRecord => ({
  id: "stack-a",
  projectId: "project-a",
  checkoutId: "checkout-a",
  contextId: "context-a",
  name: "default",
  status: "active",
  lifecycle: "stopped",
  runtimeRequest: "auto",
  paths: {
    root: "/tmp/stack",
    data: "/tmp/stack/data",
    logs: "/tmp/stack/logs",
    runtime: "/tmp/stack/runtime",
  },
  ports: [],
  serviceVersions: {},
  runtimeMetadata: { processIds: {}, containerIds: {} },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const exactPlan = (port: number): ManagedPortPlan => ({
  durable: [
    {
      field: "apiPort",
      key: "api.port",
      intent: "exact",
      selection: { kind: "exact", port },
      newlyAllocatedAutomatic: false,
    },
  ],
  runtimeOnly: [],
  inactiveAssignments: [],
});

const stickyPlan = (port: number): ManagedPortPlan => ({
  durable: [
    {
      field: "apiPort",
      key: "api.port",
      intent: "automatic",
      selection: { kind: "exact", port },
      newlyAllocatedAutomatic: false,
    },
  ],
  runtimeOnly: [],
  inactiveAssignments: [],
});

const automaticPlan = (preferred?: number): ManagedPortPlan => ({
  durable: [
    {
      field: "apiPort",
      key: "api.port",
      intent: "automatic",
      selection: preferred === undefined ? { kind: "automatic" } : { kind: "automatic", preferred },
      newlyAllocatedAutomatic: true,
    },
  ],
  runtimeOnly: [],
  inactiveAssignments: [],
});

const multiAutomaticPlan = (preferred: ReadonlyArray<number>): ManagedPortPlan => ({
  durable: [
    {
      field: "apiPort",
      key: "api.port",
      intent: "automatic",
      selection: { kind: "automatic", preferred: preferred[0] },
      newlyAllocatedAutomatic: true,
    },
    {
      field: "dbPort",
      key: "db.port",
      intent: "automatic",
      selection: { kind: "automatic", preferred: preferred[1] },
      newlyAllocatedAutomatic: true,
    },
  ],
  runtimeOnly: [],
  inactiveAssignments: [],
});

const repositoryFor = (
  options: {
    readonly reservations?: ReadonlyArray<ManagedPortReservation>;
    readonly claim?: (
      input: ClaimManagedStartPortsInput,
    ) => Effect.Effect<ManagedStackRecord, ManagedPortReservationError>;
  } = {},
): ManagedStackRepositoryShape => {
  const base = createInMemoryManagedStackRepository();
  return {
    ...base,
    listPortReservations: () => Effect.succeed(options.reservations ?? []),
    claimStartPorts:
      options.claim ??
      ((input) =>
        Effect.succeed({
          ...stack(),
          id: input.stackId,
          ports: input.ports,
          updatedAt: input.now,
        })),
  };
};

const sqlitePreparation = (root: string, id: string, operationToken: string) => ({
  identity: {
    projectId: `${id}-project`,
    checkoutId: `${id}-checkout`,
    contextId: `${id}-context`,
  },
  checkoutKind: "ordinary" as const,
  checkoutRootPath: join(root, `${id}-workspace`),
  locationId: `${id}-location`,
  context: { kind: "workspace" as const },
  stackId: id,
  stackName: id,
  paths: {
    root: join(root, id),
    data: join(root, id, "data"),
    logs: join(root, id, "logs"),
    runtime: join(root, id, "runtime"),
  },
  operationToken,
  now: "2026-01-01T00:00:00.000Z",
  configuration: {},
});

const openNodeSqlite = (path: string): ManagedSqliteDatabase => {
  const database = new DatabaseSync(path);
  return {
    exec: (sql) => database.exec(sql),
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return {
        run: (parameters = []) => {
          statement.run(...parameters);
        },
        get: (parameters = []) => statement.get(...parameters),
        all: (parameters = []) => statement.all(...parameters),
      };
    },
    close: () => database.close(),
  };
};

const memoryPreparation = (root: string, id: string, operationToken: string) => ({
  identity: {
    projectId: `${id}-project`,
    checkoutId: `${id}-checkout`,
    contextId: `${id}-context`,
  },
  checkoutKind: "ordinary" as const,
  checkoutRootPath: join(root, `${id}-workspace`),
  locationId: `${id}-location`,
  context: { kind: "workspace" as const },
  stackId: id,
  stackName: id,
  paths: {
    root: join(root, id),
    data: join(root, id, "data"),
    logs: join(root, id, "logs"),
    runtime: join(root, id, "runtime"),
  },
  operationToken,
  now: "2026-01-01T00:00:00.000Z",
  configuration: {},
});

describe("managed port coordinator", () => {
  it("binds an exact candidate, claims durable ownership, and returns a scoped lease", async () => {
    const port = await freePort();
    const plan: ManagedPortPlan = {
      durable: [
        {
          field: "apiPort",
          key: "api.port",
          intent: "exact",
          selection: { kind: "exact", port },
          newlyAllocatedAutomatic: false,
        },
      ],
      runtimeOnly: [],
      inactiveAssignments: [],
    };
    const baseRepository = createInMemoryManagedStackRepository();
    const repository = {
      ...baseRepository,
      listPortReservations: () => Effect.succeed([]),
      claimStartPorts: (input: ClaimManagedStartPortsInput) =>
        Effect.succeed({ ...stack(), id: input.stackId, ports: input.ports, updatedAt: input.now }),
    };
    const claimed: Array<ManagedPortStartAllocation> = [];
    const coordinator = ManagedPortCoordinator.make({ repository });

    const result = await Effect.runPromise(
      Effect.scoped(
        coordinator.acquireStart({
          stack: stack(),
          operationToken: "operation-a",
          plan,
          now: "2026-01-01T00:00:00.000Z",
        }),
      ),
    );

    claimed.push(result);
    expect(result.ports.apiPort).toBe(port);
    expect(result.durableAssignments).toEqual([{ key: "api.port", port, intent: "exact" }]);
    await Effect.runPromise(result.lease.releaseAll);
    expect(claimed).toHaveLength(1);
  });

  it("reports an external exact conflict with the configured key", async () => {
    const occupied = await occupiedPort();
    try {
      const coordinator = ManagedPortCoordinator.make({ repository: repositoryFor() });
      await expect(
        Effect.runPromise(
          Effect.scoped(
            coordinator.acquireStart({
              stack: stack(),
              operationToken: "operation-a",
              plan: exactPlan(occupied.port),
              now: "2026-01-01T00:00:00.000Z",
            }),
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "ManagedExactPortOccupiedError",
        key: "api.port",
        port: occupied.port,
      });
    } finally {
      await occupied.close();
    }
  });

  it("reports an external pinned sticky conflict without relocating", async () => {
    const occupied = await occupiedPort();
    try {
      const coordinator = ManagedPortCoordinator.make({ repository: repositoryFor() });
      await expect(
        Effect.runPromise(
          Effect.scoped(
            coordinator.acquireStart({
              stack: stack(),
              operationToken: "operation-a",
              plan: stickyPlan(occupied.port),
              now: "2026-01-01T00:00:00.000Z",
            }),
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "ManagedStickyPortOccupiedError",
        key: "api.port",
        stackId: "stack-a",
        port: occupied.port,
      });
    } finally {
      await occupied.close();
    }
  });

  it("falls back from an occupied conventional port for a new automatic field", async () => {
    const occupied = await occupiedPort();
    try {
      const coordinator = ManagedPortCoordinator.make({ repository: repositoryFor() });
      const result = await Effect.runPromise(
        Effect.scoped(
          coordinator.acquireStart({
            stack: stack(),
            operationToken: "operation-a",
            plan: automaticPlan(occupied.port),
            now: "2026-01-01T00:00:00.000Z",
          }),
        ),
      );
      expect(result.ports.apiPort).not.toBe(occupied.port);
      expect(result.durableAssignments[0]).toMatchObject({
        key: "api.port",
        intent: "automatic",
      });
    } finally {
      await occupied.close();
    }
  });

  it("binds fixed selections before relocating an earlier automatic preference", async () => {
    const fixedPort = await freePort();
    const plan: ManagedPortPlan = {
      durable: [
        {
          field: "apiPort",
          key: "api.port",
          intent: "automatic",
          selection: { kind: "automatic", preferred: fixedPort },
          newlyAllocatedAutomatic: true,
        },
        {
          field: "dbPort",
          key: "db.port",
          intent: "exact",
          selection: { kind: "exact", port: fixedPort },
          newlyAllocatedAutomatic: false,
        },
      ],
      runtimeOnly: [],
      inactiveAssignments: [],
    };
    const coordinator = ManagedPortCoordinator.make({ repository: repositoryFor() });
    const result = await Effect.runPromise(
      Effect.scoped(
        coordinator.acquireStart({
          stack: stack(),
          operationToken: "operation-a",
          plan,
          now: "2026-01-01T00:00:00.000Z",
        }),
      ),
    );
    expect(result.ports.dbPort).toBe(fixedPort);
    expect(result.ports.apiPort).not.toBe(fixedPort);
  });

  it("relocates a keyless runtime-only field when its previous number is occupied", async () => {
    const occupied = await occupiedPort();
    try {
      const plan: ManagedPortPlan = {
        durable: [],
        runtimeOnly: [
          { field: "authPort", selection: { kind: "automatic", preferred: occupied.port } },
        ],
        inactiveAssignments: [],
      };
      const coordinator = ManagedPortCoordinator.make({ repository: repositoryFor() });
      const result = await Effect.runPromise(
        Effect.scoped(
          coordinator.acquireStart({
            stack: stack(),
            operationToken: "operation-a",
            plan,
            now: "2026-01-01T00:00:00.000Z",
          }),
        ),
      );
      expect(result.ports.authPort).not.toBe(occupied.port);
      expect(result.durableAssignments).toEqual([]);
    } finally {
      await occupied.close();
    }
  });

  it("rejects a known exact-versus-sticky conflict with owner attribution", async () => {
    const owner: ManagedPortReservation = {
      stackId: "owner-stack",
      stackName: "owner",
      lifecycle: "stopped",
      assignment: { key: "api.port", port: await freePort(), intent: "automatic" },
    };
    const coordinator = ManagedPortCoordinator.make({
      repository: repositoryFor({ reservations: [owner] }),
    });
    await expect(
      Effect.runPromise(
        Effect.scoped(
          coordinator.acquireStart({
            stack: stack(),
            operationToken: "operation-a",
            plan: exactPlan(owner.assignment.port),
            now: "2026-01-01T00:00:00.000Z",
          }),
        ),
      ),
    ).rejects.toMatchObject({
      _tag: "ManagedExactPortOccupiedError",
      ownerStackId: "owner-stack",
      ownerStackName: "owner",
    });
  });

  it("rejects a preserved inactive collision before binding or claiming", async () => {
    const port = await freePort();
    let claims = 0;
    const coordinator = ManagedPortCoordinator.make({
      repository: repositoryFor({
        claim: (input) => {
          claims += 1;
          return Effect.succeed({ ...stack(), id: input.stackId, ports: input.ports });
        },
      }),
    });
    const plan: ManagedPortPlan = {
      durable: [
        {
          field: "apiPort",
          key: "api.port",
          intent: "exact",
          selection: { kind: "exact", port },
          newlyAllocatedAutomatic: false,
        },
      ],
      runtimeOnly: [],
      inactiveAssignments: [{ key: "db.port", port, intent: "exact" }],
    };
    await expect(
      Effect.runPromise(
        Effect.scoped(
          coordinator.acquireStart({
            stack: stack(),
            operationToken: "operation-a",
            plan,
            now: "2026-01-01T00:00:00.000Z",
          }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: "ManagedExactPortOccupiedError", port });
    expect(claims).toBe(0);
  });

  it("keeps real in-memory rows unchanged on an inactive collision", async () => {
    const root = mkdtempSync(join(tmpdir(), "managed-port-coordinator-memory-"));
    const port = await freePort();
    const repository = createInMemoryManagedStackRepository();
    const prepared = Effect.runSync(
      repository.prepareStack({
        ...memoryPreparation(root, "stack-inactive", "operation-inactive"),
        configuration: { ports: [{ key: "db.port", port, intent: "exact" }] },
      }),
    );
    if (prepared.outcome !== "create") throw new Error("Expected inactive stack to be created");
    const coordinator = ManagedPortCoordinator.make({ repository });
    const plan: ManagedPortPlan = {
      durable: [
        {
          field: "apiPort",
          key: "api.port",
          intent: "exact",
          selection: { kind: "exact", port },
          newlyAllocatedAutomatic: false,
        },
      ],
      runtimeOnly: [],
      inactiveAssignments: [{ key: "db.port", port, intent: "exact" }],
    };
    await expect(
      Effect.runPromise(
        Effect.scoped(
          coordinator.acquireStart({
            stack: prepared.stack,
            operationToken: "operation-inactive",
            plan,
            now: "2026-01-01T00:00:01.000Z",
          }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: "ManagedExactPortOccupiedError", port });
    expect(Effect.runSync(repository.listStacks())[0]?.ports).toEqual(prepared.stack.ports);
  });

  it("releases a raced automatic candidate and retries the complete set", async () => {
    let claims = 0;
    const ownerStackId = "owner-stack";
    const preferred = [await freePort(), await freePort()] as const;
    let firstCandidate: ReadonlyArray<number> | undefined;
    const repository = repositoryFor({
      claim: (input) => {
        claims += 1;
        const candidate = input.ports.map((assignment) => assignment.port);
        firstCandidate ??= candidate;
        return claims === 1
          ? Effect.fail(
              new ManagedPortReservationError({
                port: input.ports[0]?.port ?? 0,
                ownerStackId,
              }),
            )
          : Effect.succeed({
              ...stack(),
              id: input.stackId,
              ports: input.ports,
              updatedAt: input.now,
            });
      },
    });
    const coordinator = ManagedPortCoordinator.make({ repository, retryLimit: 2 });
    const result = await Effect.runPromise(
      Effect.scoped(
        coordinator.acquireStart({
          stack: stack(),
          operationToken: "operation-a",
          plan: multiAutomaticPlan(preferred),
          now: "2026-01-01T00:00:00.000Z",
        }),
      ),
    );
    expect(claims).toBe(2);
    expect(firstCandidate).toEqual([result.ports.apiPort, result.ports.dbPort]);
  });

  it("does not retry an exact repository race", async () => {
    let claims = 0;
    const repository = repositoryFor({
      claim: (input) => {
        claims += 1;
        return Effect.fail(
          new ManagedPortReservationError({
            port: input.ports[0]?.port ?? 0,
            ownerStackId: "owner-stack",
          }),
        );
      },
    });
    const coordinator = ManagedPortCoordinator.make({ repository, retryLimit: 8 });
    await expect(
      Effect.runPromise(
        Effect.scoped(
          coordinator.acquireStart({
            stack: stack(),
            operationToken: "operation-a",
            plan: exactPlan(await freePort()),
            now: "2026-01-01T00:00:00.000Z",
          }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: "ManagedPortClaimRaceError" });
    expect(claims).toBe(1);
  });

  it("releases every listener when interrupted while publishing a candidate", async () => {
    const claimStarted =
      Deferred.makeUnsafe<ReadonlyArray<{ readonly key: string; readonly port: number }>>();
    const repository = repositoryFor({
      claim: (input) => {
        if (input.ports.length < 2) throw new Error("Expected a multi-field candidate");
        return Deferred.succeed(claimStarted, input.ports).pipe(Effect.andThen(Effect.never));
      },
    });
    const coordinator = ManagedPortCoordinator.make({ repository });
    const fiber = Effect.runFork(
      Effect.scoped(
        coordinator.acquireStart({
          stack: stack(),
          operationToken: "operation-a",
          plan: multiAutomaticPlan([await freePort(), await freePort()]),
          now: "2026-01-01T00:00:00.000Z",
        }),
      ),
    );
    const candidate = await Effect.runPromise(Deferred.await(claimStarted));
    await Effect.runPromise(Fiber.interrupt(fiber));
    const rebound = await Effect.runPromise(
      reservePortSet(
        candidate.map(({ port }, index) => ({
          field: index === 0 ? "apiPort" : "dbPort",
          selection: { kind: "exact", port },
        })),
      ),
    );
    await Effect.runPromise(rebound.releaseAll);
  });

  it("releases a listener acquired before interruption between candidate binds", async () => {
    const firstBound = Deferred.makeUnsafe<number>();
    const firstPort = await freePort();
    const secondPort = await freePort();
    const coordinator = ManagedPortCoordinator.make({
      repository: repositoryFor(),
      binder: (requests, options) =>
        reservePortSet(requests, {
          ...options,
          onBound: (field, bound) =>
            field === "apiPort"
              ? Deferred.succeed(firstBound, bound.port).pipe(
                  Effect.andThen(Effect.interruptible(Effect.never)),
                )
              : Effect.void,
        }),
    });
    const fiber = Effect.runFork(
      Effect.scoped(
        coordinator.acquireStart({
          stack: stack(),
          operationToken: "operation-a",
          plan: multiAutomaticPlan([firstPort, secondPort]),
          now: "2026-01-01T00:00:00.000Z",
        }),
      ),
    );
    const bound = await Effect.runPromise(Deferred.await(firstBound));
    expect(bound).toBe(firstPort);
    await Effect.runPromise(Fiber.interrupt(fiber));
    const rebound = await Effect.runPromise(
      reservePortSet([{ field: "apiPort", selection: { kind: "exact", port: bound } }]),
    );
    await Effect.runPromise(rebound.releaseAll);
  });

  it("releases a partial multi-listener candidate when a later fixed bind fails", async () => {
    const firstPort = await freePort();
    const occupied = await occupiedPort();
    try {
      const plan: ManagedPortPlan = {
        durable: [
          {
            field: "apiPort",
            key: "api.port",
            intent: "exact",
            selection: { kind: "exact", port: firstPort },
            newlyAllocatedAutomatic: false,
          },
          {
            field: "dbPort",
            key: "db.port",
            intent: "exact",
            selection: { kind: "exact", port: occupied.port },
            newlyAllocatedAutomatic: false,
          },
        ],
        runtimeOnly: [],
        inactiveAssignments: [],
      };
      const coordinator = ManagedPortCoordinator.make({ repository: repositoryFor() });
      await expect(
        Effect.runPromise(
          Effect.scoped(
            coordinator.acquireStart({
              stack: stack(),
              operationToken: "operation-a",
              plan,
              now: "2026-01-01T00:00:00.000Z",
            }),
          ),
        ),
      ).rejects.toMatchObject({ _tag: "ManagedExactPortOccupiedError", port: occupied.port });
      const rebound = await Effect.runPromise(
        reservePortSet([{ field: "apiPort", selection: { kind: "exact", port: firstPort } }]),
      );
      await Effect.runPromise(rebound.releaseAll);
    } finally {
      await occupied.close();
    }
  });

  it("uses the real in-memory repository for preferred allocation and sticky reuse", async () => {
    const root = mkdtempSync(join(tmpdir(), "managed-port-coordinator-memory-"));
    const repository = createInMemoryManagedStackRepository();
    const first = Effect.runSync(
      repository.prepareStack(memoryPreparation(root, "stack-memory", "operation-memory-a")),
    );
    if (first.outcome !== "create") throw new Error("Expected memory stack to be created");
    const preferred = await freePort();
    const coordinator = ManagedPortCoordinator.make({ repository });
    const firstAllocation = await Effect.runPromise(
      Effect.scoped(
        coordinator.acquireStart({
          stack: first.stack,
          operationToken: "operation-memory-a",
          plan: automaticPlan(preferred),
          now: "2026-01-01T00:00:00.000Z",
        }),
      ),
    );
    expect(firstAllocation.ports.apiPort).toBe(preferred);
    await Effect.runPromise(firstAllocation.lease.releaseAll);
    Effect.runSync(
      repository.reconcileOperation(
        first.stack.id,
        "operation-memory-a",
        "running",
        "2026-01-01T00:00:01.000Z",
      ),
    );
    Effect.runSync(
      repository.claimOperation({
        stackId: first.stack.id,
        token: "operation-memory-b",
        kind: "start",
        now: "2026-01-01T00:00:02.000Z",
      }),
    );
    const stopped = Effect.runSync(
      repository.updateStack({
        stackId: first.stack.id,
        operationToken: "operation-memory-b",
        lifecycle: "stopped",
        now: "2026-01-01T00:00:03.000Z",
      }),
    );
    const stickyPort = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sticky = yield* coordinator.acquireStart({
            stack: stopped,
            operationToken: "operation-memory-b",
            plan: stickyPlan(preferred),
            now: "2026-01-01T00:00:04.000Z",
          });
          const occupied = yield* reservePortSet([
            { field: "apiPort", selection: { kind: "exact", port: preferred } },
          ]).pipe(Effect.exit);
          expect(sticky.ports.apiPort).toBe(preferred);
          expect(occupied._tag).toBe("Failure");
          return sticky.ports.apiPort;
        }),
      ),
    );
    expect(stickyPort).toBe(preferred);
  });

  it("preserves a real in-memory assignment when the claim fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "managed-port-coordinator-memory-"));
    const base = createInMemoryManagedStackRepository();
    const prepared = Effect.runSync(
      base.prepareStack(memoryPreparation(root, "stack-rollback", "operation-rollback")),
    );
    if (prepared.outcome !== "create") throw new Error("Expected rollback stack to be created");
    const previous = await freePort();
    const initial = Effect.runSync(
      base.claimStartPorts({
        stackId: prepared.stack.id,
        operationToken: "operation-rollback",
        ports: [{ key: "api.port", port: previous, intent: "automatic" }],
        now: "2026-01-01T00:00:00.000Z",
      }),
    );
    const failing: ManagedStackRepositoryShape = {
      ...base,
      claimStartPorts: () =>
        Effect.fail(new ManagedPortReservationError({ port: previous, ownerStackId: "other" })),
    };
    const coordinator = ManagedPortCoordinator.make({ repository: failing });
    await expect(
      Effect.runPromise(
        Effect.scoped(
          coordinator.acquireStart({
            stack: initial,
            operationToken: "operation-rollback",
            plan: stickyPlan(previous),
            now: "2026-01-01T00:00:01.000Z",
          }),
        ),
      ),
    ).rejects.toMatchObject({ _tag: "ManagedPortClaimRaceError" });
    expect(Effect.runSync(base.listStacks())[0]?.ports).toEqual(initial.ports);
  });

  it("persists SQLite claims and preflights a second owner through the real adapter", async () => {
    const root = mkdtempSync(join(tmpdir(), "managed-port-coordinator-"));
    const runtime = ManagedRuntime.make(
      sqliteManagedStackRepositoryLayer(() => openNodeSqlite(join(root, "registry.sqlite"))),
    );
    const repository = Context.get(await runtime.context(), ManagedStackRepository);
    try {
      const first = Effect.runSync(
        repository.prepareStack(sqlitePreparation(root, "stack-sqlite-a", "operation-sqlite-a")),
      );
      if (first.outcome !== "create") throw new Error("Expected first SQLite stack to be created");
      const port = await freePort();
      const coordinator = ManagedPortCoordinator.make({ repository });
      const allocation = await Effect.runPromise(
        Effect.scoped(
          coordinator.acquireStart({
            stack: first.stack,
            operationToken: "operation-sqlite-a",
            plan: exactPlan(port),
            now: "2026-01-01T00:00:00.000Z",
          }),
        ),
      );
      expect(
        Effect.runSync(repository.listPortReservations()).map(
          (reservation) => reservation.assignment,
        ),
      ).toEqual([{ key: "api.port", port, intent: "exact" }]);
      await Effect.runPromise(allocation.lease.releaseAll);

      const second = Effect.runSync(
        repository.prepareStack(sqlitePreparation(root, "stack-sqlite-b", "operation-sqlite-b")),
      );
      if (second.outcome !== "create")
        throw new Error("Expected second SQLite stack to be created");
      await expect(
        Effect.runPromise(
          Effect.scoped(
            coordinator.acquireStart({
              stack: second.stack,
              operationToken: "operation-sqlite-b",
              plan: exactPlan(port),
              now: "2026-01-01T00:00:00.000Z",
            }),
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "ManagedExactPortOccupiedError",
        ownerStackId: "stack-sqlite-a",
      });
    } finally {
      await runtime.dispose();
    }
  });
});
