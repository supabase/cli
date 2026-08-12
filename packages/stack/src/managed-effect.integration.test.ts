import { describe, expect, it } from "@effect/vitest";
import { BunFileSystem } from "@effect/platform-bun";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { Effect, Exit, Layer } from "effect";
import { ensureOrdinaryWorkspaceIdentity } from "./managed/identity.ts";
import {
  ManagedStackPublicationTimeoutError,
  type UnsupportedManagedRegistryVersionError,
} from "./managed/model.ts";
import { managedRegistryPath, managedStackPaths } from "./managed/paths.ts";
import { createInMemoryManagedStackRepository } from "./managed/repository-memory.ts";
import { ManagedStackRepository } from "./managed/repository.ts";
import { ManagedStackService, type ManagedStackServiceOptions } from "./managed/service.ts";
import { bunSqliteManagedStackRepositoryLayer } from "./managed/sqlite-bun.ts";

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

type ServiceOverrides = Omit<ManagedStackServiceOptions, "stateRoot">;

/**
 * The layer an Effect consumer assembles: the policy service over a repository
 * adapter over the platform filesystem. The repository is merged rather than only
 * provided so a test can drive the registry directly to stage a scenario.
 */
const managedLayer = (
  stateRoot: string,
  repositoryLayer: Layer.Layer<ManagedStackRepository, UnsupportedManagedRegistryVersionError>,
  overrides: ServiceOverrides,
) =>
  ManagedStackService.make({ stateRoot, publicationPollMs: 1, ...overrides }).pipe(
    Layer.provideMerge(repositoryLayer),
    Layer.provide(BunFileSystem.layer),
  );

const setupInMemory = (overrides: ServiceOverrides = {}) => {
  const root = makeRoot();
  const stateRoot = join(root, "managed");
  return {
    root,
    stateRoot,
    workspace: makeWorkspace(root),
    layer: managedLayer(
      stateRoot,
      Layer.succeed(ManagedStackRepository, createInMemoryManagedStackRepository()),
      overrides,
    ),
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
    openRegistry: () =>
      managedLayer(
        stateRoot,
        bunSqliteManagedStackRepositoryLayer(managedRegistryPath(stateRoot)),
        overrides,
      ),
  };
};

/**
 * Stages a pending stack whose publisher is alive but will never publish, so the
 * next provision of that workspace has to wait for a publication that never lands.
 */
const stagePendingStack = (workspace: string, stateRoot: string) =>
  Effect.gen(function* () {
    const repository = yield* ManagedStackRepository;
    const { identity } = yield* ensureOrdinaryWorkspaceIdentity(workspace);
    const stackId = crypto.randomUUID();
    const prepared = yield* repository.prepareOrdinaryStack({
      identity,
      canonicalPath: realpathSync(workspace),
      locationId: crypto.randomUUID(),
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
      const created = yield* managed.provisionOrdinaryStack({ workspacePath: workspace });
      const reused = yield* managed.provisionOrdinaryStack({ workspacePath: workspace });

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
      yield* managed.provisionOrdinaryStack({ workspacePath: workspace });
      const reused = yield* managed.provisionOrdinaryStack({
        workspacePath: workspace,
        configuration: { runtimeRequest: "docker" },
      });

      expect(reused.outcome).toBe("reuse");
      expect(reused.stack.runtimeRequest).toBe("docker");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports an unregistered workspace before anything is provisioned", () => {
    const { workspace, layer } = setupInMemory();
    return Effect.gen(function* () {
      const managed = yield* ManagedStackService;
      const before = yield* managed.inspectOrdinaryWorkspace(workspace);
      const { stack } = yield* managed.provisionOrdinaryStack({ workspacePath: workspace });
      const after = yield* managed.inspectOrdinaryWorkspace(workspace);

      expect(before).toEqual({ registered: false, stacks: [] });
      expect(after.registered).toBe(true);
      expect(after.stacks.map((candidate) => candidate.id)).toEqual([stack.id]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lets a caller recover from a rejected stack name with catchTag", () => {
    const { workspace, layer } = setupInMemory();
    return Effect.gen(function* () {
      const managed = yield* ManagedStackService;
      // The failure is in the effect's error channel, so the recovery is typed:
      // `catchTag` narrows to the one failure and its payload without a cast.
      const outcome = yield* managed
        .provisionOrdinaryStack({ workspacePath: workspace, stackName: "Not A Name" })
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
      const { stack } = yield* managed.provisionOrdinaryStack({ workspacePath: workspace });
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
      const { stack } = yield* managed.provisionOrdinaryStack({ workspacePath: workspace });

      const deleted = yield* managed.deleteStack(stack.id);
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
      const { stack } = yield* managed.provisionOrdinaryStack({ workspacePath: workspace });
      yield* managed.updateStack(stack.id, { lifecycle: "running" });

      const exit = yield* managed
        .deleteStack(stack.id, { stop: () => Effect.fail(new StopRefused()) })
        .pipe(Effect.exit);
      const survivor = yield* managed.inspectStack(stack.id);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(survivor?.status).toBe("active");
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps a stack visible to a registry handle opened after the first one closed", () => {
    const { workspace, stateRoot, openRegistry } = setupSqlite();
    return Effect.gen(function* () {
      // The registry handle belongs to the layer's scope, so each `Effect.scoped`
      // block opens the file, uses it, and closes it before the next block runs.
      const provisioned = yield* Effect.gen(function* () {
        const managed = yield* ManagedStackService;
        const repository = yield* ManagedStackRepository;
        const { stack } = yield* managed.provisionOrdinaryStack({ workspacePath: workspace });
        expect(yield* repository.getStack(stack.id)).toMatchObject({ id: stack.id });
        return stack;
      }).pipe(Effect.scoped, Effect.provide(openRegistry()));

      expect(existsSync(managedRegistryPath(stateRoot))).toBe(true);

      const reopened = yield* Effect.gen(function* () {
        const managed = yield* ManagedStackService;
        return yield* managed.provisionOrdinaryStack({ workspacePath: workspace });
      }).pipe(Effect.scoped, Effect.provide(openRegistry()));

      expect(reopened.outcome).toBe("reuse");
      expect(reopened.stack.id).toBe(provisioned.id);
    });
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
        .provisionOrdinaryStack({ workspacePath: workspace })
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
    const layer = managedLayer(
      "",
      Layer.succeed(ManagedStackRepository, createInMemoryManagedStackRepository()),
      {},
    );
    return Effect.gen(function* () {
      const exit = yield* Effect.gen(function* () {
        return yield* ManagedStackService;
      }).pipe(Effect.provide(layer), Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
    });
  });
});
