import { describe, expect, it } from "@effect/vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { Cause, Duration, Effect, Exit } from "effect";
import { ensureOrdinaryWorkspaceIdentity } from "./managed/identity.ts";
import {
  InvalidManagedIdentityError,
  ManagedLegacyPortConflictError,
  ManagedStackInitializationError,
  ManagedStackPublicationTimeoutError,
  ManagedRuntimeStartError,
} from "./managed/model.ts";
import { managedRegistryPath, managedStackPaths } from "./managed/paths.ts";
import { createInMemoryManagedStackRepository } from "./managed/repository-memory.ts";
import { ManagedStackRepository, type ManagedStackRepositoryShape } from "./managed/repository.ts";
import { ManagedStackService } from "./managed/service.ts";
import { managedStackLayer, type CreateManagedStackServiceOptions } from "./managed-bun.ts";

/**
 * The Effect surface of the managed registry, exercised as an Effect consumer
 * uses it: `yield* ManagedStackService` over a repository layer, typed failures
 * recovered with `Effect.catchTag`, and the registry handle owned by a scope.
 *
 * The Promise facade's suite in `managed-service.integration.test.ts` carries the
 * behavioral load. This suite exists to prove the Effect API is a first-class
 * entrypoint rather than an implementation detail behind that facade.
 */

const temporaryRoots: Array<string> = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "managed-effect-test-"));
  temporaryRoots.push(root);
  return root;
};

const makeWorkspace = (root: string, name = "workspace"): string => {
  const workspace = join(root, name);
  mkdirSync(workspace, { recursive: true });
  return workspace;
};

type ServiceOverrides = Omit<CreateManagedStackServiceOptions, "stateRoot">;

/**
 * The layer an Effect consumer provides — the composed one the package exports,
 * not a private re-assembly of it, so this suite fails if that assembly drifts.
 * The repository is part of it, so a test can drive the registry directly to
 * stage a scenario.
 */
const managedLayer = (stateRoot: string, overrides: ServiceOverrides) =>
  managedStackLayer({ stateRoot, publicationPollMs: 1, ...overrides });

const setupInMemory = (overrides: ServiceOverrides = {}) => {
  const root = makeRoot();
  const stateRoot = join(root, "managed");
  return {
    root,
    stateRoot,
    workspace: makeWorkspace(root),
    layer: managedLayer(stateRoot, {
      repository: createInMemoryManagedStackRepository(),
      ...overrides,
    }),
  };
};

const setupSqlite = (overrides: ServiceOverrides = {}) => {
  const root = makeRoot();
  const stateRoot = join(root, "managed");
  return {
    root,
    stateRoot,
    workspace: makeWorkspace(root),
    /** A fresh handle on the same registry file, the way a second process opens it. */
    openRegistry: () => managedLayer(stateRoot, overrides),
  };
};

const effectPortDocument = (fixtureId: string, apiPort: number) => {
  if (fixtureId === "ports.env-and-remote-values-remain-exact") {
    return {
      activeFields: ["apiPort", "dbPort"] as const,
      document: { api: { port: apiPort }, db: { port: apiPort + 1 } },
      valueOrigins: [
        { path: ["api", "port"], source: "environment" as const },
        { path: ["db", "port"], source: "remote" as const },
      ],
    };
  }
  if (
    fixtureId === "ports.new-target-allocates-and-persists-omitted-ports" ||
    fixtureId === "ports.sibling-targets-allocate-independent-ports"
  ) {
    return { activeFields: ["apiPort", "dbPort"] as const, document: {} };
  }
  if (
    fixtureId === "ports.sticky-ports-reuse-on-return" ||
    fixtureId === "ports.later-sticky-port-collision-fails"
  ) {
    return { activeFields: ["apiPort"] as const, document: {} };
  }
  return { activeFields: ["apiPort"] as const, document: { api: { port: apiPort } } };
};

const freeEffectPort = (): Effect.Effect<number, Error> =>
  Effect.callback<number, Error>((resume) => {
    const server = createServer();
    server.once("error", (error) => resume(Effect.die(error)));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        resume(Effect.die(new Error("Ephemeral port probe returned no numeric address")));
        return;
      }
      const port = address.port;
      server.close(() => resume(Effect.succeed(port)));
    });
  });

/**
 * Stages a pending stack whose publisher is alive but will never publish, so the
 * next provision of that workspace has to wait for a publication that never lands.
 */
const stagePendingStack = (workspace: string, stateRoot: string) =>
  Effect.gen(function* () {
    const repository = yield* ManagedStackRepository;
    const { identity } = yield* ensureOrdinaryWorkspaceIdentity(workspace);
    const stackId = crypto.randomUUID();
    const prepared = yield* repository.prepareStack({
      identity,
      checkoutKind: "ordinary",
      checkoutRootPath: realpathSync(workspace),
      locationId: crypto.randomUUID(),
      context: { kind: "workspace" },
      stackId,
      stackName: "default",
      paths: managedStackPaths(stateRoot, stackId),
      operationToken: crypto.randomUUID(),
      ownerPid: process.pid,
      now: "2026-08-11T00:00:00.000Z",
      configuration: {},
    });
    if (prepared.outcome !== "create") {
      return yield* Effect.die(new Error("Expected to stage a pending managed stack"));
    }
    mkdirSync(prepared.stack.paths.data, { recursive: true });
    return prepared.stack;
  });

describe("managed stack Effect surface", () => {
  it.effect("provisions a stack for a new workspace and reuses it on the next call", () => {
    const { workspace, layer } = setupInMemory();
    return Effect.gen(function* () {
      const managed = yield* ManagedStackService;
      const created = yield* managed.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      });
      const reused = yield* managed.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      });

      expect(created.outcome).toBe("create");
      expect(reused.outcome).toBe("reuse");
      expect(reused.stack.id).toBe(created.stack.id);
      expect(reused.selection).toEqual(created.selection);
      expect(existsSync(created.stack.paths.data)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("adopts a caller's configuration when it reuses a stack", () => {
    const { workspace, layer } = setupInMemory();
    return Effect.gen(function* () {
      const managed = yield* ManagedStackService;
      yield* managed.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      });
      const reused = yield* managed.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: workspace,
        configuration: { runtimeRequest: "docker" },
      });

      expect(reused.outcome).toBe("reuse");
      expect(reused.stack.runtimeRequest).toBe("auto");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports an unregistered workspace before anything is provisioned", () => {
    const { workspace, layer } = setupInMemory();
    return Effect.gen(function* () {
      const managed = yield* ManagedStackService;
      const before = yield* managed.resolveStack({
        portDocument: { activeFields: [], document: {} },
        workspacePath: workspace,
        operation: "status",
      });
      const { stack } = yield* managed.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      });
      const after = yield* managed.resolveStack({
        portDocument: { activeFields: [], document: {} },
        workspacePath: workspace,
        operation: "status",
      });

      expect(before.state).toBe("unregistered");
      expect(before.identity).toEqual({});
      expect(before.stacks).toEqual([]);
      expect(after.state).toBe("running");
      expect(after.selection?.stackId).toBe(stack.id);
      expect(after.stacks.map((candidate) => candidate.id)).toEqual([stack.id]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects conflicting recovery path spellings before mutation", () => {
    const { workspace, layer } = setupInMemory();
    return Effect.gen(function* () {
      const managed = yield* ManagedStackService;
      const exit = yield* Effect.exit(
        managed.newCheckout({ workspacePath: workspace, path: `${workspace}-other` }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toBeInstanceOf(InvalidManagedIdentityError);
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets a caller recover from a rejected stack name with catchTag", () => {
    const { workspace, layer } = setupInMemory();
    return Effect.gen(function* () {
      const managed = yield* ManagedStackService;
      // The failure is in the effect's error channel, so the recovery is typed:
      // `catchTag` narrows to the one failure and its payload without a cast.
      const outcome = yield* managed
        .resolveStack({
          portDocument: { activeFields: [], document: {} },
          initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
          operation: "start",
          workspacePath: workspace,
          stackName: "Not A Name",
        })
        .pipe(
          Effect.catchTag("InvalidManagedStackNameError", (error) =>
            Effect.succeed(`rejected ${error.stackName}`),
          ),
        );
      const stacks = yield* managed.listStacks();

      expect(outcome).toBe("rejected Not A Name");
      expect(stacks).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails a stopped-stack requirement rather than deleting a running stack", () => {
    const { workspace, layer } = setupInMemory();
    return Effect.gen(function* () {
      const managed = yield* ManagedStackService;
      const { stack } = yield* managed.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      });
      yield* managed.updateStack(stack.id, { lifecycle: "running" });

      const refused = yield* managed
        .deleteStack(stack.id)
        .pipe(
          Effect.catchTag("ManagedStackNotStoppedError", (error) => Effect.succeed(error._tag)),
        );
      const survivor = yield* managed.inspectStack(stack.id);

      expect(refused).toBe("ManagedStackNotStoppedError");
      expect(survivor?.lifecycle).toBe("running");
    }).pipe(Effect.provide(layer));
  });

  it.effect("deletes a stack once and treats a repeated delete as a no-op", () => {
    const { workspace, layer } = setupInMemory();
    return Effect.gen(function* () {
      const managed = yield* ManagedStackService;
      const { stack } = yield* managed.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      });

      const deleted = yield* managed.deleteStack(stack.id, { stop: () => Effect.void });
      const repeated = yield* managed.deleteStack(stack.id);

      expect(deleted.outcome).toBe("delete");
      expect(deleted.dataReclamation.outcome).toBe("removed");
      expect(repeated.outcome).toBe("no-op");
      expect(existsSync(stack.paths.root)).toBe(false);
      expect((yield* managed.inspectStack(stack.id))?.status).toBe("tombstoned");
    }).pipe(Effect.provide(layer));
  });

  it.effect("propagates a stop callback's own failure type out of deleteStack", () => {
    const { workspace, layer } = setupInMemory();
    class StopRefused {
      readonly _tag = "StopRefused";
    }
    return Effect.gen(function* () {
      const managed = yield* ManagedStackService;
      const { stack } = yield* managed.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      });
      yield* managed.updateStack(stack.id, { lifecycle: "running" });

      const exit = yield* managed
        .deleteStack(stack.id, { stop: () => Effect.fail(new StopRefused()) })
        .pipe(Effect.exit);
      const survivor = yield* managed.inspectStack(stack.id);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(survivor?.status).toBe("active");
    }).pipe(Effect.provide(layer));
  });

  // `it.live` rather than `it.effect`: this is the one test that drives the real
  // SQLite adapter, whose cold start waits out another process' WAL conversion on
  // a schedule. Under `TestClock` such a wait would never be released and the test
  // would hang instead of failing.
  it.live("keeps a stack visible to a registry handle opened after the first one closed", () => {
    const { workspace, stateRoot, openRegistry } = setupSqlite();
    return Effect.gen(function* () {
      // The registry handle belongs to the layer's scope, which `Effect.provide`
      // owns, so each block opens the file, uses it, and closes it before the
      // next block runs.
      const provisioned = yield* Effect.gen(function* () {
        const managed = yield* ManagedStackService;
        const repository = yield* ManagedStackRepository;
        const { stack } = yield* managed.resolveStack({
          portDocument: { activeFields: [], document: {} },
          initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
          workspacePath: workspace,
          operation: "start",
        });
        expect(yield* repository.getStack(stack.id)).toMatchObject({ id: stack.id });
        return stack;
      }).pipe(Effect.provide(openRegistry()));

      expect(existsSync(managedRegistryPath(stateRoot))).toBe(true);

      const reopened = yield* Effect.gen(function* () {
        const managed = yield* ManagedStackService;
        return yield* managed.resolveStack({
          portDocument: { activeFields: [], document: {} },
          initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
          workspacePath: workspace,
          operation: "start",
        });
      }).pipe(Effect.provide(openRegistry()));

      expect(reopened.outcome).toBe("reuse");
      expect(reopened.stack.id).toBe(provisioned.id);
    });
  });

  it.live("rolls a provision back when the caller interrupts it mid-initialization", () => {
    // A caller that times out or closes the service while initialization is
    // running still owns the pending row, the operation claim, and the stack
    // directory the provision created, so the compensation has to run even
    // though the fiber it belongs to is being interrupted. The interruption
    // itself must stay an interruption: a provision this caller abandoned is
    // not an initialization that failed.
    const { workspace, stateRoot, layer } = setupInMemory();
    return Effect.gen(function* () {
      const managed = yield* ManagedStackService;
      const repository = yield* ManagedStackRepository;

      const exit = yield* managed
        .resolveStack({
          portDocument: { activeFields: [], document: {} },
          operation: "start",
          workspacePath: workspace,
          initialize: () =>
            Effect.sleep(Duration.seconds(5)).pipe(Effect.as({ processIds: {}, containerIds: {} })),
        })
        .pipe(Effect.timeout(Duration.millis(50)), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      expect(failure).not.toBeInstanceOf(ManagedStackInitializationError);
      expect(yield* repository.listStacks({ includeTombstoned: true })).toEqual([]);
      expect(yield* repository.listActiveOperations()).toEqual([]);
      const stackRoots = join(stateRoot, "stacks");
      expect(existsSync(stackRoots) ? readdirSync(stackRoots) : []).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("leaves no claim behind when a provision is interrupted while it is being taken", () => {
    // An embedder repository may be asynchronous, so the pending row and its
    // claim can be committed on the far side of a suspension point — and an
    // interruption delivered there arrives after this call owns them and before
    // it has anything installed to compensate them. What the caller must never
    // be left with is a pending stack claimed by a live pid: every later start
    // reads that as a publication in progress and waits the whole timeout out.
    const root = makeRoot();
    const stateRoot = join(root, "managed");
    const workspace = makeWorkspace(root);
    const repository = createInMemoryManagedStackRepository();
    const slowToAnswer: ManagedStackRepositoryShape = {
      ...repository,
      prepareStack: (input) =>
        Effect.flatMap(repository.prepareStack(input), (prepared) =>
          Effect.as(Effect.sleep(Duration.millis(50)), prepared),
        ),
    };
    const layer = managedLayer(stateRoot, { repository: slowToAnswer });
    return Effect.gen(function* () {
      const exit = yield* Effect.flatMap(ManagedStackService, (managed) =>
        managed.resolveStack({
          portDocument: { activeFields: [], document: {} },
          initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
          operation: "start",
          workspacePath: workspace,
        }),
      ).pipe(Effect.timeout(Duration.millis(5)), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* repository.listStacks({ includeTombstoned: true })).toEqual([]);
      expect(yield* repository.listActiveOperations()).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("leaves no claim behind when a delete is interrupted while it is being claimed", () => {
    // `deleteStack`'s claim has the same shape as a provision's: taking it must
    // be inside the region that releases it, or an interruption landing between
    // the two leaves the stack claimed by an operation nobody will ever finish.
    const root = makeRoot();
    const stateRoot = join(root, "managed");
    const workspace = makeWorkspace(root);
    const repository = createInMemoryManagedStackRepository();
    let claimIsSlow = false;
    const slowToClaim: ManagedStackRepositoryShape = {
      ...repository,
      claimOperation: (input) =>
        Effect.flatMap(repository.claimOperation(input), (claimed) =>
          claimIsSlow
            ? Effect.as(Effect.sleep(Duration.millis(50)), claimed)
            : Effect.succeed(claimed),
        ),
    };
    const layer = managedLayer(stateRoot, { repository: slowToClaim });
    return Effect.gen(function* () {
      const managed = yield* ManagedStackService;
      const { stack } = yield* managed.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      });
      claimIsSlow = true;

      const exit = yield* managed
        .deleteStack(stack.id)
        .pipe(Effect.timeout(Duration.millis(5)), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(yield* repository.listActiveOperations()).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("releases the delete claim when the caller interrupts a stop that never returns", () => {
    const { workspace, layer } = setupInMemory();
    return Effect.gen(function* () {
      const managed = yield* ManagedStackService;
      const repository = yield* ManagedStackRepository;
      const { stack } = yield* managed.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      });
      yield* managed.updateStack(stack.id, { lifecycle: "running" });

      const exit = yield* managed
        .deleteStack(stack.id, { stop: () => Effect.sleep(Duration.seconds(5)) })
        .pipe(Effect.timeout(Duration.millis(50)), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      // The claim is gone, so the next caller can delete the stack instead of
      // being refused by an operation nobody will ever finish.
      expect(yield* repository.listActiveOperations()).toEqual([]);
      expect((yield* managed.inspectStack(stack.id))?.status).toBe("active");
    }).pipe(Effect.provide(layer));
  });

  it.live("keeps a delete's own failure when releasing its claim reports interruption", () => {
    // Releasing the claim on the way out is best effort in the strongest sense.
    // An embedder repository whose `finishOperation` is cancelled must not turn
    // the failure the caller actually suffered into an interruption the caller
    // never asked for — the release has no outcome of its own to report.
    const root = makeRoot();
    const stateRoot = join(root, "managed");
    const workspace = makeWorkspace(root);
    const repository = createInMemoryManagedStackRepository();
    let releaseIsCancelled = false;
    const cancelling: ManagedStackRepositoryShape = {
      ...repository,
      finishOperation: (stackId, operationToken, outcome, at, error) =>
        releaseIsCancelled
          ? Effect.interrupt
          : repository.finishOperation(stackId, operationToken, outcome, at, error),
    };
    const layer = managedLayer(stateRoot, { repository: cancelling });
    class StopRefused {
      readonly _tag = "StopRefused";
    }
    return Effect.gen(function* () {
      const managed = yield* ManagedStackService;
      const { stack } = yield* managed.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      });
      yield* managed.updateStack(stack.id, { lifecycle: "running" });
      releaseIsCancelled = true;

      const exit = yield* managed
        .deleteStack(stack.id, { stop: () => Effect.fail(new StopRefused()) })
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(false);
      expect(Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined).toBeInstanceOf(
        StopRefused,
      );
      expect((yield* managed.inspectStack(stack.id))?.status).toBe("active");
    }).pipe(Effect.provide(layer));
  });

  it.live("propagates an interrupted runtime inspection instead of retaining the operation", () => {
    // The absorbed steps inside a recovery pass follow the same rule as the pass
    // itself: an interrupted inspection has no answer about the runtime, so
    // retaining the operation on its behalf would report a decision recovery
    // never made.
    const { workspace, layer } = setupInMemory();
    return Effect.gen(function* () {
      const managed = yield* ManagedStackService;
      const repository = yield* ManagedStackRepository;
      const { stack } = yield* managed.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      });
      const claimed = yield* repository.claimOperation({
        token: crypto.randomUUID(),
        stackId: stack.id,
        kind: "start",
        now: "2026-08-11T00:00:00.000Z",
      });
      if (!claimed.acquired) {
        return yield* Effect.die(new Error("Expected to stage an abandoned operation"));
      }

      const exit = yield* managed
        .reconcileAbandonedOperations({ inspectRuntime: () => Effect.interrupt })
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      // The claim survives for the next pass, exactly as it would had the pass
      // never looked at it.
      expect(
        (yield* repository.listActiveOperations()).map((operation) => operation.token),
      ).toEqual([claimed.operation.token]);
    }).pipe(Effect.provide(layer));
  });

  it.live("propagates an interrupted recovery pass instead of recording it as a failure", () => {
    // Recovery reports rather than fails, but an interrupted step has no outcome
    // to report: recording one would mark a stack failed and release a claim on
    // behalf of a caller that is no longer there, and the operation the next pass
    // should still recover would look like one recovery already gave up on.
    const root = makeRoot();
    const stateRoot = join(root, "managed");
    const workspace = makeWorkspace(root);
    const repository = createInMemoryManagedStackRepository();
    // An embedder-supplied repository may be asynchronous, and a call into one
    // can be cancelled: the step then reports interruption rather than a refusal.
    const cancelling: ManagedStackRepositoryShape = {
      ...repository,
      reconcileOperation: () => Effect.interrupt,
    };
    const layer = managedLayer(stateRoot, { repository: cancelling });
    return Effect.gen(function* () {
      const managed = yield* ManagedStackService;
      const { stack } = yield* managed.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      });
      // An abandoned claim with no owner to probe, so recovery goes straight to
      // reconciling it.
      const claimed = yield* repository.claimOperation({
        token: crypto.randomUUID(),
        stackId: stack.id,
        kind: "start",
        now: "2026-08-11T00:00:00.000Z",
      });
      if (!claimed.acquired) {
        return yield* Effect.die(new Error("Expected to stage an abandoned operation"));
      }

      const exit = yield* managed
        .reconcileAbandonedOperations({ inspectRuntime: () => Effect.succeed("stopped") })
        .pipe(Effect.exit);

      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect((yield* managed.inspectStack(stack.id))?.lifecycle).not.toBe("failed");
      expect(
        (yield* repository.listActiveOperations()).map((operation) => operation.token),
      ).toEqual([claimed.operation.token]);
    }).pipe(Effect.provide(layer));
  });

  it.live("gives up on a pending stack whose publisher never publishes", () => {
    // Deliberately `it.live` with a tiny window rather than `TestClock`.
    // `TestClock.adjust` only releases sleeps that are already registered, and
    // provision does real identity and registry I/O before it reaches its first
    // poll, so a forked provision has not parked yet when the adjustment runs:
    // the advance passes through, no sleep is released, and the join never
    // returns. A two-millisecond real deadline is the honest bound here.
    const { workspace, stateRoot, layer } = setupInMemory({
      publicationTimeoutMs: 2,
      publicationPollMs: 1,
      isProcessAlive: () => true,
    });
    return Effect.gen(function* () {
      const managed = yield* ManagedStackService;
      const pending = yield* stagePendingStack(workspace, stateRoot);

      const timedOut = yield* managed
        .resolveStack({
          portDocument: { activeFields: [], document: {} },
          initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
          workspacePath: workspace,
          operation: "start",
        })
        .pipe(
          Effect.catchTag("ManagedStackPublicationTimeoutError", (error) => Effect.succeed(error)),
        );
      const stacks = yield* managed.listStacks();

      expect(timedOut).toBeInstanceOf(ManagedStackPublicationTimeoutError);
      expect(stacks.map((stack) => stack.id)).toEqual([pending.id]);
      expect(stacks[0]?.status).toBe("pending");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses to build a service over a blank state root", () => {
    // A blank root would anchor every managed path to the process' working
    // directory, so the layer must fail while it is being built rather than at
    // whichever call first touches a path.
    const layer = managedLayer("", { repository: createInMemoryManagedStackRepository() });
    return Effect.gen(function* () {
      const exit = yield* Effect.gen(function* () {
        return yield* ManagedStackService;
      }).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.effect("settles a failed runtime with durable ports on the Effect surface", () => {
    const { workspace, layer } = setupInMemory();
    return Effect.gen(function* () {
      const managed = yield* ManagedStackService;
      const exit = yield* managed
        .resolveStack({
          operation: "start",
          workspacePath: workspace,
          portDocument: { activeFields: ["apiPort"], document: {} },
          initialize: () => Effect.fail(new ManagedRuntimeStartError({ cause: "boot failed" })),
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const stack = yield* managed.listStacks();
      expect(stack).toHaveLength(1);
      expect(stack[0]?.lifecycle).toBe("failed");
      expect(stack[0]?.ports).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("conforms representative ports.* lifecycle scenarios on both adapters", () => {
    const cases = [
      ["in-memory", "exact-default"] as const,
      ["sqlite", "exact-default"] as const,
      ["in-memory", "env-remote"] as const,
      ["sqlite", "env-remote"] as const,
      ["in-memory", "legacy"] as const,
      ["sqlite", "legacy"] as const,
      ["in-memory", "running-drift"] as const,
      ["sqlite", "running-drift"] as const,
      ["in-memory", "failure-retention"] as const,
      ["sqlite", "failure-retention"] as const,
    ];
    return Effect.forEach(
      cases,
      ([adapter, scenario]) => {
        const setup =
          adapter === "in-memory"
            ? (() => {
                const value = setupInMemory();
                return { workspace: value.workspace, layer: value.layer };
              })()
            : (() => {
                const value = setupSqlite();
                return { workspace: value.workspace, layer: value.openRegistry() };
              })();
        const workspace = setup.workspace;
        return Effect.gen(function* () {
          const managed = yield* ManagedStackService;
          const apiPort = yield* freeEffectPort();
          const remotePort = scenario === "env-remote" ? yield* freeEffectPort() : apiPort + 1;
          const fixtureId =
            scenario === "env-remote"
              ? "ports.env-and-remote-values-remain-exact"
              : scenario === "exact-default"
                ? "ports.exact-default-value-differs-from-omitted-default"
                : "ports.explicit-free-port-is-used";
          const portDocument =
            scenario === "env-remote"
              ? {
                  activeFields: ["apiPort", "dbPort"] as const,
                  document: { api: { port: apiPort }, db: { port: remotePort } },
                  valueOrigins: [
                    { path: ["api", "port"], source: "environment" as const },
                    { path: ["db", "port"], source: "remote" as const },
                  ],
                }
              : scenario === "exact-default"
                ? {
                    activeFields: ["apiPort", "dbPort"] as const,
                    document: { api: { port: apiPort } },
                  }
                : effectPortDocument(fixtureId, apiPort);
          if (scenario === "legacy") {
            const exit = yield* managed
              .resolveStack({
                workspacePath: workspace,
                operation: "start",
                portDocument,
                initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
                legacyPortConflict: { key: "api.port", port: apiPort, ownerId: "legacy" },
              })
              .pipe(Effect.exit);
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(Cause.squash(exit.cause)).toBeInstanceOf(ManagedLegacyPortConflictError);
            }
            expect(yield* managed.listStacks()).toEqual([]);
            return;
          }
          if (scenario === "running-drift") {
            const started = yield* managed.resolveStack({
              workspacePath: workspace,
              operation: "start",
              portDocument,
              initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
            });
            let initialized = 0;
            const changedPort = yield* freeEffectPort();
            const drifted = yield* managed.resolveStack({
              workspacePath: workspace,
              operation: "start",
              portDocument: effectPortDocument(fixtureId, changedPort),
              initialize: () =>
                Effect.sync(() => {
                  initialized += 1;
                  return { processIds: {}, containerIds: {} };
                }),
            });
            expect(drifted.outcome).toBe("reuse");
            expect(drifted.portDrift).toEqual([
              expect.objectContaining({
                key: "api.port",
                actualPort: apiPort,
                configuredPort: changedPort,
              }),
            ]);
            expect(initialized).toBe(0);
            expect((yield* managed.inspectStack(started.stack.id))?.lifecycle).toBe("running");
            return;
          }
          if (scenario === "failure-retention") {
            const failed = yield* managed
              .resolveStack({
                workspacePath: workspace,
                operation: "start",
                portDocument,
                initialize: () =>
                  Effect.fail(new ManagedRuntimeStartError({ cause: "fixture failure" })),
              })
              .pipe(Effect.exit);
            expect(Exit.isFailure(failed)).toBe(true);
            const stacks = yield* managed.listStacks();
            expect(stacks[0]?.lifecycle).toBe("failed");
            expect(stacks[0]?.ports.length).toBeGreaterThan(0);
            return;
          }
          const started = yield* managed.resolveStack({
            workspacePath: workspace,
            operation: "start",
            portDocument,
            initialize: () => Effect.succeed({ processIds: {}, containerIds: {} }),
          });
          expect(started.state).toBe("running");
          if (scenario === "exact-default") {
            expect(started.stack.ports).toEqual([
              { key: "api.port", port: apiPort, intent: "exact" },
              expect.objectContaining({ key: "db.port", intent: "automatic" }),
            ]);
          }
          if (scenario === "env-remote") {
            expect(started.stack.ports).toEqual([
              { key: "api.port", port: apiPort, intent: "exact" },
              { key: "db.port", port: remotePort, intent: "exact" },
            ]);
          }
          const status = yield* managed.resolveStack({
            workspacePath: workspace,
            operation: "status",
            portDocument,
          });
          expect(status.state).toBe("running");
        }).pipe(Effect.provide(setup.layer));
      },
      { discard: true },
    );
  });
});
