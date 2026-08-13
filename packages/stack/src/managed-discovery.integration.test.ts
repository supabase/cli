import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { symlinkSync, renameSync } from "node:fs";
import { writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { ordinaryWorkspaceIdentityPath } from "./managed/paths.ts";
import {
  git,
  makeDirectory,
  makeRepository,
  temporaryRoots,
} from "../tests/helpers/git-workspace.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import { createInMemoryManagedStackRepository } from "./managed/repository-memory.ts";
import { ManagedStackRepository, type ManagedStackRepositoryShape } from "./managed/repository.ts";
import { discoverWorkspace } from "./managed/discovery.ts";
import { createManagedStackService, makeManagedStackService } from "./managed-bun.ts";

const { makeRoot, removeAll } = temporaryRoots("managed-discovery-test-");

const openHandles: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  for (const handle of openHandles.splice(0)) await handle.close();
  removeAll();
});

const adapters = [
  [
    "in-memory",
    (root: string) =>
      makeManagedStackService({
        repository: createInMemoryManagedStackRepository(),
        stateRoot: join(root, "managed"),
        publicationPollMs: 1,
      }),
  ],
  [
    "sqlite",
    (root: string) =>
      createManagedStackService({ stateRoot: join(root, "managed"), publicationPollMs: 1 }),
  ],
] as const;

const inspect = async (repository: ManagedStackRepositoryShape, workspacePath: string) => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      BunFileSystem.layer,
      gitConfigStoreLayer,
      Layer.succeed(ManagedStackRepository, repository),
    ),
  );
  try {
    return await runtime.runPromise(discoverWorkspace(workspacePath));
  } finally {
    await runtime.dispose();
  }
};

const mutationDenied = (
  repository: ManagedStackRepositoryShape,
  calls: { count: number },
): ManagedStackRepositoryShape => {
  const touched =
    <A extends ReadonlyArray<unknown>, R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      calls.count += 1;
      return fn(...args);
    };
  return {
    ...repository,
    prepareStack: touched(repository.prepareStack),
    publishPendingStack: touched(repository.publishPendingStack),
    abortPendingStack: touched(repository.abortPendingStack),
    claimOperation: touched(repository.claimOperation),
    finishOperation: touched(repository.finishOperation),
    updateStack: touched(repository.updateStack),
    reconcileOperation: touched(repository.reconcileOperation),
    tombstoneStack: touched(repository.tombstoneStack),
    applyCheckoutLocation: touched(repository.applyCheckoutLocation),
    refreshContextOwner: touched(repository.refreshContextOwner),
    reserveIdentityTransition: touched(repository.reserveIdentityTransition),
    advanceIdentityTransition: touched(repository.advanceIdentityTransition),
    finalizeIdentityTransition: touched(repository.finalizeIdentityTransition),
    pruneIdentityMetadata: touched(repository.pruneIdentityMetadata),
    pruneCheckoutLocations: touched(repository.pruneCheckoutLocations),
  };
};

const snapshotTree = (root: string): ReadonlyArray<string> => {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true });
  return entries
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory()
        ? snapshotTree(path).map((child) => join(entry.name, child))
        : [entry.name];
    })
    .sort();
};

describe.each(adapters)("managed discovery with the %s adapter", (_name, open) => {
  it("reports an unregistered git checkout without invoking repository mutations", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await open(root);
    openHandles.push(service);
    const calls = { count: 0 };
    const instrumented = mutationDenied(service.repository, calls);

    const report = await inspect(instrumented, repository);
    expect(report.state).toBe("unregistered");
    expect(report.identity).toEqual({});
    expect(report.recoveryOperations).toEqual([{ operation: "newCheckout", path: repository }]);
    expect(calls.count).toBe(0);
  });

  it("resolves healthy branch, detached, and ordinary identities", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const ordinary = makeDirectory(root, "ordinary");
    const service = await open(root);
    openHandles.push(service);

    const branch = await service.resolveStack({ workspacePath: repository, operation: "start" });
    const branchReport = await inspect(service.repository, repository);
    expect(branchReport.state).toBe("healthy");
    expect(branchReport.identity).toEqual(branch.identity);
    expect(branchReport.stacks.map((stack) => stack.id)).toContain(branch.stack.id);

    git(repository, "checkout", "-q", "--detach", "HEAD");
    const detached = await service.resolveStack({ workspacePath: repository, operation: "start" });
    const detachedReport = await inspect(service.repository, repository);
    expect(detachedReport.state).toBe("healthy");
    expect(detachedReport.identity).toEqual(detached.identity);

    const ordinaryReport = await inspect(service.repository, ordinary);
    expect(ordinaryReport.state).toBe("unregistered");
    expect(ordinaryReport.context.kind).toBe("workspace");
    const ordinaryStarted = await service.resolveStack({
      workspacePath: ordinary,
      operation: "start",
    });
    const ordinaryHealthy = await inspect(service.repository, ordinary);
    expect(ordinaryHealthy.state).toBe("healthy");
    expect(ordinaryHealthy.identity).toEqual(ordinaryStarted.identity);
    const alias = join(root, "ordinary-alias");
    symlinkSync(ordinary, alias, "dir");
    const aliasReport = await inspect(service.repository, alias);
    expect(aliasReport.workspace.canonicalPath).toBe(ordinary);
    const status = await service.resolveStack({ workspacePath: alias, operation: "status" });
    expect(status.identity).toEqual(ordinaryStarted.identity);
  });

  it("automatically rebinds a checkout whose previous path is definitely missing", async () => {
    const root = makeRoot();
    const previous = makeRepository(root);
    const next = join(root, "moved-checkout");
    const service = await open(root);
    openHandles.push(service);
    const first = await service.resolveStack({ workspacePath: previous, operation: "start" });
    renameSync(previous, next);

    const report = await inspect(service.repository, next);
    expect(report.state).toBe("moved");
    expect(report.recoveryOperations).toEqual([
      { operation: "rebindCheckout", checkoutId: first.identity.checkoutId, path: next },
    ]);

    const rebound = await service.resolveStack({ workspacePath: next, operation: "start" });
    expect(rebound.identity).toEqual(first.identity);
    expect(rebound.stack.id).toBe(first.stack.id);
    const claims = await Effect.runPromise(service.repository.listIdentityClaims());
    expect(
      claims.locations
        .filter((location) => location.checkoutId === first.identity.checkoutId)
        .map((location) => [location.canonicalPath, location.state]),
    ).toEqual(
      expect.arrayContaining([
        [previous, "superseded"],
        [next, "active"],
      ]),
    );
  });

  it("publishes a new checkout identity without claiming a stack", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "new-checkout");
    const service = await open(root);
    openHandles.push(service);

    const published = await service.newCheckout({ workspacePath: workspace });
    expect(published.identity.projectId).toBeDefined();
    expect(published.identity.checkoutId).toBeDefined();
    expect(await service.listStacks()).toEqual([]);
    const started = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    expect(started.identity).toEqual(published.identity);
  });

  it("does not alias a checkout when its previous path is recycled", async () => {
    const root = makeRoot();
    const previous = makeRepository(root);
    const next = join(root, "recycled-checkout");
    const service = await open(root);
    openHandles.push(service);
    const first = await service.resolveStack({ workspacePath: previous, operation: "start" });
    renameSync(previous, next);
    makeDirectory(root, previous.slice(root.length + 1));
    await expect(
      service.resolveStack({ workspacePath: next, operation: "start" }),
    ).rejects.toMatchObject({
      _tag: "ManagedCheckoutConflictError",
    });
    const report = await inspect(service.repository, next);
    expect(report.state).toBe("duplicate");
    expect(report.identity.checkoutId).toBe(first.identity.checkoutId);
  });

  it("supports explicit rebind and refuses adoption of a healthy checkout", async () => {
    const root = makeRoot();
    const previous = makeRepository(root);
    const next = join(root, "explicit-recovery");
    const service = await open(root);
    openHandles.push(service);
    const first = await service.resolveStack({ workspacePath: previous, operation: "start" });
    renameSync(previous, next);

    const rebound = await service.rebindCheckout({
      workspacePath: next,
      checkoutId: first.identity.checkoutId,
    });
    expect(rebound.identity).toEqual(first.identity);
    expect(rebound.locations).toEqual(
      expect.arrayContaining([expect.objectContaining({ canonicalPath: next, state: "active" })]),
    );

    await expect(
      service.adoptCheckout({
        workspacePath: next,
        checkoutId: first.identity.checkoutId,
      }),
    ).rejects.toMatchObject({ _tag: "InvalidManagedIdentityError" });
  });

  it("canonicalizes an explicit recovery alias without registering the alias path", async () => {
    const root = makeRoot();
    const previous = makeRepository(root);
    const next = join(root, "canonical-recovery");
    const alias = join(root, "canonical-recovery-alias");
    const service = await open(root);
    openHandles.push(service);
    const first = await service.resolveStack({ workspacePath: previous, operation: "start" });
    renameSync(previous, next);
    symlinkSync(next, alias, "dir");

    const rebound = await service.rebindCheckout({
      workspacePath: alias,
      checkoutId: first.identity.checkoutId,
    });
    expect(rebound.workspace.workspaceRoot).toBe(next);
    const claims = await Effect.runPromise(service.repository.listIdentityClaims());
    expect(claims.locations.map((location) => location.canonicalPath)).not.toContain(alias);
    expect(claims.locations).toEqual(
      expect.arrayContaining([expect.objectContaining({ canonicalPath: next, state: "active" })]),
    );
  }, 15_000);

  it("blocks both the active and historical paths when a superseded path reappears", async () => {
    const root = makeRoot();
    const previous = makeRepository(root);
    const next = join(root, "historical-reappearance");
    const service = await open(root);
    openHandles.push(service);
    const first = await service.resolveStack({ workspacePath: previous, operation: "start" });
    renameSync(previous, next);
    await service.resolveStack({ workspacePath: next, operation: "start" });
    symlinkSync(next, previous, "dir");

    for (const workspacePath of [next, previous]) {
      const report = await inspect(service.repository, workspacePath);
      expect(report.state).toBe("duplicate");
      expect(report.identity.checkoutId).toBe(first.identity.checkoutId);
      await expect(
        service.resolveStack({ workspacePath, operation: "start" }),
      ).rejects.toMatchObject({ _tag: "ManagedCheckoutConflictError" });
    }
  }, 15_000);

  it("resumes an interrupted rebind when the marker still matches", async () => {
    const root = makeRoot();
    const previous = makeRepository(root);
    const next = join(root, "resumable-recovery");
    const service = await open(root);
    openHandles.push(service);
    const first = await service.resolveStack({ workspacePath: previous, operation: "start" });
    renameSync(previous, next);
    await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: "00000000-0000-7000-8000-000000000093",
        kind: "rebind-checkout",
        checkoutId: first.identity.checkoutId,
        projectId: first.identity.projectId,
        path: next,
        now: new Date().toISOString(),
      }),
    );
    const report = await inspect(service.repository, next);
    expect(report.state).toBe("transitioning");
    const resumed = await service.rebindCheckout({
      workspacePath: next,
      checkoutId: first.identity.checkoutId,
      observation: report,
    });
    expect(resumed.state).toBe("healthy");
    const after = await inspect(service.repository, next);
    expect(after.activeTransition).toBeUndefined();
  });

  it("advances a reserved rebind before publishing its registry location", async () => {
    const root = makeRoot();
    const previous = makeRepository(root);
    const next = join(root, "phase-order-recovery");
    const service = await open(root);
    openHandles.push(service);
    const first = await service.resolveStack({ workspacePath: previous, operation: "start" });
    renameSync(previous, next);
    await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: "00000000-0000-7000-8000-000000000094",
        kind: "rebind-checkout",
        checkoutId: first.identity.checkoutId,
        projectId: first.identity.projectId,
        contextId: first.identity.contextId,
        path: next,
        now: new Date().toISOString(),
      }),
    );
    const order: string[] = [];
    const ordered: ManagedStackRepositoryShape = {
      ...service.repository,
      advanceIdentityTransition: (input) =>
        Effect.tap(service.repository.advanceIdentityTransition(input), () =>
          Effect.sync(() => order.push("advance")),
        ),
      applyCheckoutLocation: (input) =>
        Effect.tap(service.repository.applyCheckoutLocation(input), () =>
          Effect.sync(() => order.push("location")),
        ),
    };
    const resumedService = await makeManagedStackService({
      repository: ordered,
      stateRoot: join(root, "phase-order-managed"),
      publicationPollMs: 1,
    });
    openHandles.push(resumedService);
    await resumedService.rebindCheckout({
      workspacePath: next,
      checkoutId: first.identity.checkoutId,
    });
    expect(order).toEqual(["advance", "location"]);
  });

  it("refuses a reserved recovery when a historical path is inaccessible", async () => {
    const root = makeRoot();
    const previous = makeRepository(root);
    const next = join(root, "inaccessible-recovery");
    const service = await open(root);
    openHandles.push(service);
    const first = await service.resolveStack({ workspacePath: previous, operation: "start" });
    renameSync(previous, next);
    writeFileSync(previous, "not a checkout\n");
    await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: "00000000-0000-7000-8000-000000000095",
        kind: "rebind-checkout",
        checkoutId: first.identity.checkoutId,
        projectId: first.identity.projectId,
        contextId: first.identity.contextId,
        path: next,
        now: new Date().toISOString(),
      }),
    );
    const before = await Effect.runPromise(service.repository.listIdentityClaims());
    await expect(
      service.rebindCheckout({ workspacePath: next, checkoutId: first.identity.checkoutId }),
    ).rejects.toMatchObject({ _tag: "ManagedInaccessiblePathError" });
    const after = await Effect.runPromise(service.repository.listIdentityClaims());
    expect(after.locations).toEqual(before.locations);
    expect(after.transitions).toEqual(before.transitions);
  });

  it("refuses an interrupted recovery when its historical path reappears", async () => {
    const root = makeRoot();
    const previous = makeRepository(root);
    const next = join(root, "interrupted-reappearance");
    const service = await open(root);
    openHandles.push(service);
    const first = await service.resolveStack({ workspacePath: previous, operation: "start" });
    renameSync(previous, next);
    await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: "00000000-0000-7000-8000-000000000096",
        kind: "rebind-checkout",
        checkoutId: first.identity.checkoutId,
        projectId: first.identity.projectId,
        contextId: first.identity.contextId,
        path: next,
        now: new Date().toISOString(),
      }),
    );
    symlinkSync(next, previous, "dir");
    const before = await Effect.runPromise(service.repository.listIdentityClaims());

    await expect(
      service.rebindCheckout({ workspacePath: next, checkoutId: first.identity.checkoutId }),
    ).rejects.toMatchObject({ _tag: "ManagedCheckoutConflictError" });

    const after = await Effect.runPromise(service.repository.listIdentityClaims());
    expect(after.locations).toEqual(before.locations);
    expect(after.transitions).toEqual(before.transitions);
    expect(after.transitions.find((transition) => transition.id.endsWith("0096"))?.phase).toBe(
      "reserved",
    );
  }, 15_000);

  it("does not finalize recovery when a historical path reappears during registry apply", async () => {
    const root = makeRoot();
    const previous = makeRepository(root);
    const next = join(root, "apply-race-reappearance");
    const service = await open(root);
    openHandles.push(service);
    const first = await service.resolveStack({ workspacePath: previous, operation: "start" });
    renameSync(previous, next);
    const beforeStacks = await Effect.runPromise(service.repository.listStacks());
    let injected = false;
    const racingRepository: ManagedStackRepositoryShape = {
      ...service.repository,
      applyCheckoutLocation: (input) =>
        Effect.gen(function* () {
          if (!injected) {
            injected = true;
            symlinkSync(next, previous, "dir");
          }
          return yield* service.repository.applyCheckoutLocation(input);
        }),
    };
    const racingService = await makeManagedStackService({
      repository: racingRepository,
      stateRoot: join(root, "apply-race-managed"),
      publicationPollMs: 1,
    });
    openHandles.push(racingService);

    await expect(
      racingService.rebindCheckout({ workspacePath: next, checkoutId: first.identity.checkoutId }),
    ).rejects.toMatchObject({ _tag: "ManagedCheckoutConflictError" });

    const claims = await Effect.runPromise(service.repository.listIdentityClaims());
    const transition = claims.transitions.find(
      (candidate) => candidate.checkoutId === first.identity.checkoutId,
    );
    expect(transition?.phase).toBe("git-written");
    expect(claims.locations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ canonicalPath: next, state: "active" }),
        expect.objectContaining({ canonicalPath: previous, state: "superseded" }),
      ]),
    );
    expect(await Effect.runPromise(service.repository.listStacks())).toEqual(beforeStacks);
    const report = await inspect(service.repository, next);
    expect(report.historicalPathEvidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: previous, probe: "same" })]),
    );
  }, 15_000);

  it("refuses checkout adoption for an ownerless branch context", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await open(root);
    openHandles.push(service);
    const started = await service.resolveStack({ workspacePath: repository, operation: "start" });
    const ownerless: ManagedStackRepositoryShape = {
      ...service.repository,
      listIdentityClaims: (projectId) =>
        Effect.orDie(
          Effect.map(service.repository.listIdentityClaims(projectId), (claims) => ({
            ...claims,
            contexts: claims.contexts.map((context) =>
              context.id === started.identity.contextId
                ? { ...context, ownerBranch: undefined }
                : context,
            ),
          })),
        ),
    };
    const ownerlessService = await makeManagedStackService({
      repository: ownerless,
      stateRoot: join(root, "ownerless-recovery"),
      publicationPollMs: 1,
    });
    openHandles.push(ownerlessService);
    const before = await Effect.runPromise(service.repository.listIdentityClaims());

    await expect(
      ownerlessService.adoptCheckout({
        workspacePath: repository,
        checkoutId: started.identity.checkoutId,
      }),
    ).rejects.toMatchObject({ _tag: "InvalidManagedIdentityError" });

    const after = await Effect.runPromise(service.repository.listIdentityClaims());
    expect(after.locations).toEqual(before.locations);
    expect(after.transitions).toEqual(before.transitions);
  });

  it("settles concurrent rebinds with one CAS winner", async () => {
    const root = makeRoot();
    const previous = makeRepository(root);
    const next = join(root, "concurrent-recovery");
    const service = await open(root);
    openHandles.push(service);
    const first = await service.resolveStack({ workspacePath: previous, operation: "start" });
    renameSync(previous, next);
    const outcomes = await Promise.allSettled([
      service.rebindCheckout({ workspacePath: next, checkoutId: first.identity.checkoutId }),
      service.rebindCheckout({ workspacePath: next, checkoutId: first.identity.checkoutId }),
    ]);
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
    const successful = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value] : [],
    );
    expect(
      successful.every((result) => result.identity.checkoutId === first.identity.checkoutId),
    ).toBe(true);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        expect(outcome.reason).toMatchObject({
          _tag: "ManagedIdentityTransitionOwnershipError",
        });
      }
    }
    const report = await inspect(service.repository, next);
    expect(report.state).toBe("healthy");
    expect(report.activeTransition).toBeUndefined();
  });

  it("reports an active identity transition without attempting recovery", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await open(root);
    openHandles.push(service);
    const started = await service.resolveStack({ workspacePath: repository, operation: "start" });
    await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: "00000000-0000-7000-8000-000000000001",
        kind: "rebind-checkout",
        checkoutId: started.identity.checkoutId,
        path: repository,
        now: new Date().toISOString(),
      }),
    );
    const report = await inspect(service.repository, repository);
    expect(report.state).toBe("transitioning");
    expect(report.activeTransition?.phase).toBe("reserved");
    expect(report.recoveryOperations).toEqual([]);
    await expect(
      service.resolveStack({ workspacePath: repository, operation: "start" }),
    ).rejects.toMatchObject({ _tag: "InvalidManagedIdentityError" });
  });

  it("keeps every repository mutation untouched for status and transition refusal", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await open(root);
    openHandles.push(service);
    const started = await service.resolveStack({ workspacePath: repository, operation: "start" });
    await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: "00000000-0000-7000-8000-000000000002",
        kind: "rebind-checkout",
        checkoutId: started.identity.checkoutId,
        path: repository,
        now: new Date().toISOString(),
      }),
    );
    const calls = { count: 0 };
    const beforeClaims = await Effect.runPromise(service.repository.listIdentityClaims());
    const beforeStacks = await Effect.runPromise(service.repository.listStacks());
    const beforeOperations = await Effect.runPromise(service.repository.listActiveOperations());
    const markerPath = join(repository, ".git", "supabase-checkout.json");
    const beforeMarker = existsSync(markerPath) ? readFileSync(markerPath, "utf8") : undefined;
    const wrapped = mutationDenied(service.repository, calls);
    const report = await inspect(wrapped, repository);
    expect(report.state).toBe("transitioning");
    const guarded = await makeManagedStackService({
      repository: wrapped,
      stateRoot: join(root, "guarded"),
      publicationPollMs: 1,
    });
    openHandles.push(guarded);
    await expect(
      guarded.resolveStack({ workspacePath: repository, operation: "status" }),
    ).resolves.toMatchObject({
      operation: "status",
    });
    await expect(
      guarded.resolveStack({ workspacePath: repository, operation: "start" }),
    ).rejects.toMatchObject({ _tag: "InvalidManagedIdentityError" });
    expect(calls.count).toBe(0);
    expect(await Effect.runPromise(service.repository.listIdentityClaims())).toEqual(beforeClaims);
    expect(await Effect.runPromise(service.repository.listStacks())).toEqual(beforeStacks);
    expect(await Effect.runPromise(service.repository.listActiveOperations())).toEqual(
      beforeOperations,
    );
    expect(existsSync(markerPath) ? readFileSync(markerPath, "utf8") : undefined).toBe(
      beforeMarker,
    );
  });

  it("rejects a start when registry claims change between discovery passes", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await open(root);
    openHandles.push(service);
    const started = await service.resolveStack({ workspacePath: repository, operation: "start" });
    const calls = { count: 0 };
    const guarded = mutationDenied(service.repository, calls);
    let injected = false;
    const racing: ManagedStackRepositoryShape = {
      ...guarded,
      listIdentityClaims: (projectId) =>
        Effect.gen(function* () {
          const stale = yield* service.repository.listIdentityClaims(projectId);
          if (!injected) {
            injected = true;
            yield* service.repository.reserveIdentityTransition({
              id: "00000000-0000-7000-8000-000000000096",
              kind: "rebind-checkout",
              projectId: started.identity.projectId,
              checkoutId: started.identity.checkoutId,
              path: repository,
              now: new Date().toISOString(),
            });
          }
          return stale;
        }).pipe(Effect.orDie),
    };
    const markerPath = join(repository, ".git", "supabase-checkout.json");
    const configPath = join(repository, ".git", "config");
    const beforeClaims = await Effect.runPromise(service.repository.listIdentityClaims());
    const beforeStacks = await Effect.runPromise(service.repository.listStacks());
    const beforeOperations = await Effect.runPromise(service.repository.listActiveOperations());
    const beforeMarker = readFileSync(markerPath, "utf8");
    const beforeConfig = readFileSync(configPath, "utf8");
    const beforeTree = snapshotTree(join(root, "race-managed"));
    const racingService = await makeManagedStackService({
      repository: racing,
      stateRoot: join(root, "race-managed"),
      publicationPollMs: 1,
    });
    openHandles.push(racingService);
    await expect(
      racingService.resolveStack({ workspacePath: repository, operation: "start" }),
    ).rejects.toMatchObject({ _tag: "InvalidManagedIdentityError" });
    expect(calls.count).toBe(0);
    const afterClaims = await Effect.runPromise(service.repository.listIdentityClaims());
    expect(afterClaims.locations).toEqual(beforeClaims.locations);
    expect(afterClaims.contexts).toEqual(beforeClaims.contexts);
    expect(afterClaims.transitions).toHaveLength(beforeClaims.transitions.length + 1);
    expect(
      afterClaims.transitions.some(
        (transition) => transition.id === "00000000-0000-7000-8000-000000000096",
      ),
    ).toBe(true);
    expect(await Effect.runPromise(service.repository.listStacks())).toEqual(beforeStacks);
    expect(await Effect.runPromise(service.repository.listActiveOperations())).toEqual(
      beforeOperations,
    );
    expect(readFileSync(markerPath, "utf8")).toBe(beforeMarker);
    expect(readFileSync(configPath, "utf8")).toBe(beforeConfig);
    expect(snapshotTree(join(root, "race-managed"))).toEqual(beforeTree);
  });

  it("reports malformed checkout markers as typed identity errors", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await open(root);
    openHandles.push(service);
    await service.resolveStack({ workspacePath: repository, operation: "start" });
    writeFileSync(join(repository, ".git", "supabase-checkout.json"), "not-json\n");
    await expect(
      service.resolveStack({ workspacePath: repository, operation: "status" }),
    ).rejects.toMatchObject({
      _tag: "InvalidManagedIdentityError",
    });
  });

  it("discovers linked worktree identity at its canonical root", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const linked = join(root, "linked");
    git(repository, "worktree", "add", "-q", linked, "-b", "linked");
    const service = await open(root);
    openHandles.push(service);
    const started = await service.resolveStack({ workspacePath: linked, operation: "start" });
    const nested = makeDirectory(linked, "nested");
    const report = await inspect(service.repository, nested);
    expect(report.workspace.workspaceRoot).toBe(linked);
    expect(report.identity).toEqual(started.identity);
  });

  it("rejects contradictory ordinary marker context", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "contradiction");
    const service = await open(root);
    openHandles.push(service);
    const started = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    const markerPath = ordinaryWorkspaceIdentityPath(workspace);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { contextId: string };
    marker.contextId = "00000000-0000-7000-8000-000000000099";
    writeFileSync(markerPath, `${JSON.stringify(marker)}\n`);
    const report = await inspect(service.repository, workspace);
    expect(report.state).toBe("duplicate");
    expect(report.identity.contextId).toBe(marker.contextId);
    expect(report.registryContextId).toBe(started.identity.contextId);
    expect(report.recoveryOperations).toEqual([]);
    await expect(
      service.resolveStack({ workspacePath: workspace, operation: "start" }),
    ).rejects.toMatchObject({ _tag: "ManagedCheckoutConflictError" });
  });

  it("classifies superseded and blocked location reappearance as duplicate", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "history");
    const service = await open(root);
    openHandles.push(service);
    const started = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    const claims = await Effect.runPromise(service.repository.listIdentityClaims());
    const old = claims.locations.find(
      (location) => location.checkoutId === started.identity.checkoutId,
    );
    if (old === undefined) throw new Error("missing location");
    await Effect.runPromise(
      service.repository.applyCheckoutLocation({
        checkoutId: old.checkoutId,
        locationId: "00000000-0000-7000-8000-000000000098",
        canonicalPath: join(root, "moved"),
        now: new Date().toISOString(),
      }),
    );
    const report = await inspect(service.repository, workspace);
    expect(report.state).toBe("duplicate");
    expect(report.recoveryOperations).toEqual([]);
    await expect(
      service.resolveStack({ workspacePath: workspace, operation: "start" }),
    ).rejects.toMatchObject({ _tag: "ManagedCheckoutConflictError" });
    await Effect.runPromise(
      service.repository.applyCheckoutLocation({
        checkoutId: old.checkoutId,
        locationId: old.id,
        canonicalPath: old.canonicalPath,
        now: new Date().toISOString(),
      }),
    );
    const blocked = await inspect(service.repository, workspace);
    expect(blocked.state).toBe("duplicate");
    expect(blocked.recoveryOperations).toEqual([]);
  });

  it("reuses identity for an unborn branch", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "unborn");
    git(workspace, "init", "-q");
    const service = await open(root);
    openHandles.push(service);
    const first = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    const second = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    expect(second.identity).toEqual(first.identity);
    expect(second.stack.id).toBe(first.stack.id);
  });

  it("matches a root transition when discovering from nested cwd", async () => {
    const root = makeRoot();
    const workspace = makeRepository(root);
    const nested = makeDirectory(workspace, "nested-transition");
    const service = await open(root);
    openHandles.push(service);
    const started = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: "00000000-0000-7000-8000-000000000097",
        kind: "rebind-checkout",
        projectId: started.identity.projectId,
        checkoutId: started.identity.checkoutId,
        path: workspace,
        now: new Date().toISOString(),
      }),
    );
    const report = await inspect(service.repository, nested);
    expect(report.state).toBe("transitioning");
  });

  it("reports copied live branch ownership as duplicate", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await open(root);
    openHandles.push(service);
    const main = await service.resolveStack({ workspacePath: repository, operation: "start" });
    await Effect.runPromise(
      service.repository.refreshContextOwner({
        contextId: main.identity.contextId,
        ownerBranch: "main",
        locator: "main",
        now: new Date().toISOString(),
      }),
    );
    const ownerReport = await inspect(service.repository, repository);
    expect(ownerReport.state).toBe("healthy");
    git(repository, "branch", "copy");
    git(repository, "config", `branch.copy.supabaseContextId`, main.identity.contextId);
    git(repository, "checkout", "-q", "copy");
    const report = await inspect(service.repository, repository);
    expect(report.state).toBe("duplicate");
    const copied = await service.resolveStack({ workspacePath: repository, operation: "start" });
    expect(copied.outcome).toBe("create");
    expect(copied.identity.contextId).not.toBe(main.identity.contextId);
    expect(copied.stack.id).not.toBe(main.stack.id);
    git(repository, "checkout", "-q", "main");
    const ownerAgain = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
    });
    expect(ownerAgain.outcome).toBe("reuse");
    expect(ownerAgain.identity.contextId).toBe(main.identity.contextId);
    expect(ownerAgain.stack.id).toBe(main.stack.id);
  });

  it("requires adoption when a branch context has no authoritative owner", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await open(root);
    openHandles.push(service);
    const started = await service.resolveStack({ workspacePath: repository, operation: "start" });
    const ownerless: ManagedStackRepositoryShape = {
      ...service.repository,
      listIdentityClaims: (projectId) =>
        Effect.orDie(
          Effect.map(service.repository.listIdentityClaims(projectId), (claims) => ({
            ...claims,
            contexts: claims.contexts.map((context) =>
              context.id === started.identity.contextId
                ? { ...context, ownerBranch: undefined }
                : context,
            ),
          })),
        ),
    };
    const report = await inspect(ownerless, repository);
    expect(report.state).toBe("orphaned");
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.recoveryOperations).toContainEqual({
      operation: "adoptContext",
      contextId: started.identity.contextId,
      branch: "main",
    });
  });

  it("reports a renamed branch with a gone owner as adoptable", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await open(root);
    openHandles.push(service);
    const main = await service.resolveStack({ workspacePath: repository, operation: "start" });
    await Effect.runPromise(
      service.repository.refreshContextOwner({
        contextId: main.identity.contextId,
        ownerBranch: "main",
        locator: "main",
        now: new Date().toISOString(),
      }),
    );
    git(repository, "branch", "-m", "renamed");
    const report = await inspect(service.repository, repository);
    expect(report.state).toBe("adoptable");
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.recoveryOperations.length).toBeGreaterThan(0);
  });

  it("refuses adoption for a branch not advertised by discovery without reserving a transition", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await open(root);
    openHandles.push(service);
    const main = await service.resolveStack({ workspacePath: repository, operation: "start" });
    git(repository, "branch", "-m", "renamed");
    const report = await service.discoverWorkspace(repository);
    expect(report.state).toBe("adoptable");
    const before = await Effect.runPromise(service.repository.listIdentityClaims());
    await expect(
      service.adoptContext({
        workspacePath: repository,
        branch: "not-the-current-branch",
        observation: report,
      }),
    ).rejects.toMatchObject({ _tag: "InvalidManagedIdentityError" });
    const after = await Effect.runPromise(service.repository.listIdentityClaims());
    expect(after).toEqual(before);
    expect(main.identity.contextId).toBe(report.identity.contextId);
  });
});
