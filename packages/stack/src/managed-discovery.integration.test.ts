import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { cpSync, symlinkSync, renameSync } from "node:fs";
import { writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import {
  gitCheckoutIdentityPath,
  gitConfigPath,
  ordinaryWorkspaceIdentityPath,
} from "./managed/paths.ts";
import {
  git,
  makeDirectory,
  makeRepository,
  storedConfigValue,
  temporaryRoots,
} from "../tests/helpers/git-workspace.ts";
import { GIT_PROJECT_ID_KEY, gitBranchContextIdKey, gitConfigStoreLayer } from "./managed/git.ts";
import { createInMemoryManagedStackRepository } from "./managed/repository-memory.ts";
import { ManagedStackRepository, type ManagedStackRepositoryShape } from "./managed/repository.ts";
import { discoverWorkspace } from "./managed/discovery.ts";
import {
  createManagedStackService,
  makeManagedStackService,
  ManagedCopiedBranchConflictError,
  ManagedIdentityTransitionOwnershipError,
} from "./managed-bun.ts";

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

const gitStatus = (workspacePath: string): string => git(workspacePath, "status", "--porcelain");

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

  it("rejects conflicting recovery path spellings before mutation", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "recovery-path");
    const service = await open(root);
    openHandles.push(service);
    const readOptional = (path: string): string | undefined =>
      existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const snapshot = async () => ({
      claims: await Effect.runPromise(service.repository.listIdentityClaims()),
      locations: await Effect.runPromise(service.repository.listCheckoutLocations()),
      stacks: await Effect.runPromise(service.repository.listStacks({ includeTombstoned: true })),
      operations: await Effect.runPromise(service.repository.listActiveOperations()),
      tree: snapshotTree(root),
      identityFiles: {
        ordinaryMarker: readOptional(ordinaryWorkspaceIdentityPath(workspace)),
        gitConfig: readOptional(gitConfigPath(join(workspace, ".git"))),
        gitMarker: readOptional(gitCheckoutIdentityPath(join(workspace, ".git"))),
      },
    });

    const beforeNewCheckout = await snapshot();
    await expect(
      service.newCheckout({
        workspacePath: workspace,
        path: join(root, "different-path"),
      }),
    ).rejects.toMatchObject({ _tag: "InvalidManagedIdentityError" });
    expect(await snapshot()).toEqual(beforeNewCheckout);

    const transitionId = "00000000-0000-7000-8000-000000000301";
    await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: transitionId,
        kind: "new-checkout",
        path: workspace,
        now: new Date().toISOString(),
      }),
    );
    const beforeAbandon = await snapshot();
    await expect(
      service.abandonIdentityTransition({
        transitionId,
        workspacePath: workspace,
        path: join(root, "different-path"),
      }),
    ).rejects.toMatchObject({ _tag: "InvalidManagedIdentityError" });
    const afterAbandon = await snapshot();
    expect(afterAbandon).toEqual(beforeAbandon);
    expect(afterAbandon.claims.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: transitionId, kind: "new-checkout", phase: "reserved" }),
      ]),
    );
  });

  it("settles unrelated first starts while registry claims change between observations", async () => {
    const root = makeRoot();
    const workspaceA = makeRepository(root, "workspace-a");
    const workspaceB = makeRepository(root, "workspace-b");
    const stateRoot = join(root, "shared-managed");
    let serviceA: Awaited<ReturnType<typeof open>>;
    let serviceB: Awaited<ReturnType<typeof open>>;
    let injected = false;
    let injectedStart: Promise<unknown> | undefined;

    if (_name === "in-memory") {
      const shared = createInMemoryManagedStackRepository();
      serviceB = await makeManagedStackService({
        repository: shared,
        stateRoot,
        publicationPollMs: 1,
      });
      const wrapped: ManagedStackRepositoryShape = {
        ...shared,
        listIdentityClaims: (projectId) =>
          Effect.gen(function* () {
            const stale = yield* shared.listIdentityClaims(projectId);
            if (!injected) {
              injected = true;
              const start = serviceB.resolveStack({
                workspacePath: workspaceB,
                operation: "start",
              });
              injectedStart = start;
              yield* Effect.promise(() => start).pipe(Effect.asVoid);
            }
            return stale;
          }).pipe(Effect.orDie),
      };
      serviceA = await makeManagedStackService({
        repository: wrapped,
        stateRoot,
        publicationPollMs: 1,
      });
    } else {
      serviceB = await open(root);
      const base = await open(root);
      const wrapped: ManagedStackRepositoryShape = {
        ...base.repository,
        listIdentityClaims: (projectId) =>
          Effect.gen(function* () {
            const stale = yield* base.repository.listIdentityClaims(projectId);
            if (!injected) {
              injected = true;
              const start = serviceB.resolveStack({
                workspacePath: workspaceB,
                operation: "start",
              });
              injectedStart = start;
              yield* Effect.promise(() => start).pipe(Effect.asVoid);
            }
            return stale;
          }).pipe(Effect.orDie),
      };
      serviceA = await makeManagedStackService({
        repository: wrapped,
        stateRoot,
        publicationPollMs: 1,
      });
    }
    openHandles.push(serviceA, serviceB);

    const startedA = await serviceA.resolveStack({ workspacePath: workspaceA, operation: "start" });
    expect(injected).toBe(true);
    expect(injectedStart).toBeDefined();
    await injectedStart;
    expect(startedA.identity.checkoutId).toBeDefined();

    const reportA = await serviceA.discoverWorkspace(workspaceA);
    expect(reportA.locations.map((location) => location.canonicalPath)).not.toContain(workspaceB);
    const fresh = makeDirectory(root, "workspace-c");
    const reportFresh = await serviceA.discoverWorkspace(fresh);
    expect(reportFresh.locations.map((location) => location.canonicalPath)).not.toContain(
      workspaceB,
    );
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

    const recovered = await inspect(service.repository, next);
    const prune = recovered.recoveryOperations.find((operation) => operation.operation === "prune");
    expect(prune).toBeUndefined();
  });

  it("allows a fresh checkout to claim a vacated historical path", async () => {
    const root = makeRoot();
    const previous = makeRepository(root, "project-a");
    const next = join(root, "project-b");
    const service = await open(root);
    openHandles.push(service);

    const original = await service.resolveStack({ workspacePath: previous, operation: "start" });
    renameSync(previous, next);
    const rebound = await service.resolveStack({ workspacePath: next, operation: "start" });
    expect(rebound.identity).toEqual(original.identity);

    git(root, "clone", "-q", next, previous);
    const fresh = await service.resolveStack({ workspacePath: previous, operation: "start" });

    expect(fresh.identity.checkoutId).not.toBe(original.identity.checkoutId);
    expect(fresh.identity.projectId).not.toBe(original.identity.projectId);
    expect(fresh.stack.id).not.toBe(original.stack.id);
  });

  it("reuses one checkout when it moves away and returns to its original path", async () => {
    const root = makeRoot();
    const originalPath = makeRepository(root, "project-a");
    const movedPath = join(root, "project-b");
    const service = await open(root);
    openHandles.push(service);

    const original = await service.resolveStack({
      workspacePath: originalPath,
      operation: "start",
    });
    renameSync(originalPath, movedPath);
    const moved = await service.resolveStack({ workspacePath: movedPath, operation: "start" });
    expect(moved.identity).toEqual(original.identity);

    renameSync(movedPath, originalPath);
    const returnReport = await inspect(service.repository, originalPath);
    expect(returnReport).toMatchObject({
      state: "moved",
      historicalPathEvidence: expect.arrayContaining([
        expect.objectContaining({ path: movedPath, locationState: "active", probe: "missing" }),
      ]),
    });
    const returned = await service.resolveStack({
      workspacePath: originalPath,
      operation: "start",
    });

    expect(returned.identity).toEqual(original.identity);
    expect(returned.stack.id).toBe(original.stack.id);
    const locations = (await Effect.runPromise(service.repository.listIdentityClaims())).locations;
    expect(locations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkoutId: original.identity.checkoutId,
          canonicalPath: originalPath,
          state: "active",
        }),
        expect.objectContaining({
          checkoutId: original.identity.checkoutId,
          canonicalPath: movedPath,
          state: "superseded",
        }),
      ]),
    );
  });

  it("emits an actionable prune operation only for unprotected stale history", async () => {
    const root = makeRoot();
    const workspace = makeRepository(root);
    const service = await open(root);
    openHandles.push(service);
    const started = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    const staleId = "00000000-0000-7000-8000-000000000097";
    const stalePath = join(root, "stale-history");
    let stalePresent = true;
    const repository: ManagedStackRepositoryShape = {
      ...service.repository,
      listIdentityClaims: (projectId) =>
        Effect.map(service.repository.listIdentityClaims(projectId), (claims) => ({
          ...claims,
          locations: stalePresent
            ? [
                ...claims.locations,
                {
                  id: staleId,
                  checkoutId: started.identity.checkoutId,
                  canonicalPath: stalePath,
                  state: "superseded" as const,
                  lastSeenAt: new Date().toISOString(),
                },
              ]
            : claims.locations,
        })),
      pruneIdentityMetadata: (input) =>
        Effect.map(
          service.repository.pruneIdentityMetadata({
            locationIds: input.locationIds.filter((id) => id !== staleId),
          }),
          (result) => {
            if (!stalePresent || !input.locationIds.includes(staleId)) return result;
            stalePresent = false;
            return {
              removed: result.removed + 1,
              prunedRecordIds: [...result.prunedRecordIds, staleId],
              preservedRecordIds: result.preservedRecordIds,
              unknownRecordIds: result.unknownRecordIds,
            };
          },
        ),
    };
    const report = await inspect(repository, workspace);
    const prune = report.recoveryOperations.find((operation) => operation.operation === "prune");
    expect(prune).toEqual({ operation: "prune", recordIds: [staleId] });

    const staleService = await makeManagedStackService({
      repository,
      stateRoot: join(root, "stale-prune-managed"),
      publicationPollMs: 1,
    });
    openHandles.push(staleService);
    if (prune?.operation !== "prune") throw new Error("expected an actionable prune operation");
    await expect(staleService.prune(prune)).resolves.toMatchObject({
      removed: 1,
      prunedRecordIds: [staleId],
      preservedRecordIds: [],
      unknownRecordIds: [],
    });
    expect(stalePresent).toBe(false);
    expect(await service.inspectStack(started.stack.id)).toMatchObject({ status: "active" });
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

  it("completes an explicitly requested new checkout from partial Git identity", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const projectId = "00000000-0000-7000-8000-000000000101";
    const contextId = "00000000-0000-7000-8000-000000000102";
    git(repository, "config", GIT_PROJECT_ID_KEY, projectId);
    git(repository, "config", gitBranchContextIdKey("main"), contextId);
    const service = await open(root);
    openHandles.push(service);

    const before = await inspect(service.repository, repository);
    expect(before.state).toBe("unregistered");
    expect(before.identity).toEqual({ projectId, contextId });
    const published = await service.newCheckout({ workspacePath: repository });

    expect(published.identity.projectId).toBe(projectId);
    expect(published.identity.contextId).toBe(contextId);
    expect(published.identity.checkoutId).toBeDefined();
    expect(published.state).toBe("healthy");
  });

  it("refuses a reserved new checkout after the observed branch changes", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await open(root);
    openHandles.push(service);
    let interruptReservation = true;
    const interruptedRepository: ManagedStackRepositoryShape = {
      ...service.repository,
      reserveIdentityTransition: (input) =>
        Effect.flatMap(service.repository.reserveIdentityTransition(input), (transition) => {
          if (!interruptReservation) return Effect.succeed(transition);
          interruptReservation = false;
          return Effect.fail(
            new ManagedIdentityTransitionOwnershipError({ transitionId: transition.id }),
          );
        }),
    };
    const interrupted = await makeManagedStackService({
      repository: interruptedRepository,
      stateRoot: join(root, "branch-bound-managed"),
      publicationPollMs: 1,
    });
    openHandles.push(interrupted);
    await expect(interrupted.newCheckout({ workspacePath: repository })).rejects.toMatchObject({
      _tag: "ManagedIdentityTransitionOwnershipError",
    });
    git(repository, "checkout", "-q", "-b", "other");
    const configPath = gitConfigPath(join(repository, ".git"));
    const markerPath = gitCheckoutIdentityPath(join(repository, ".git"));
    const configBefore = readFileSync(configPath, "utf8");
    const markerBefore = existsSync(markerPath) ? readFileSync(markerPath, "utf8") : undefined;
    const claimsBefore = await Effect.runPromise(service.repository.listIdentityClaims());

    await expect(interrupted.newCheckout({ workspacePath: repository })).rejects.toMatchObject({
      _tag: "ManagedIdentityTransitionOwnershipError",
    });
    expect(await Effect.runPromise(service.repository.listIdentityClaims())).toEqual(claimsBefore);
    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
    expect(existsSync(markerPath) ? readFileSync(markerPath, "utf8") : undefined).toBe(
      markerBefore,
    );
    expect(claimsBefore.transitions).toContainEqual(
      expect.objectContaining({ kind: "new-checkout", phase: "reserved", branch: "main" }),
    );
    expect((await inspect(service.repository, repository)).activeTransition).toBeUndefined();
  });

  it("refuses a project winner that appears before field-specific publication", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const winnerProject = "00000000-0000-7000-8000-000000000108";
    const targetProject = "00000000-0000-7000-8000-000000000109";
    const targetCheckout = "00000000-0000-7000-8000-000000000110";
    const targetContext = "00000000-0000-7000-8000-000000000111";
    const generated = [
      "00000000-0000-7000-8000-000000000112",
      targetProject,
      targetCheckout,
      targetContext,
      "00000000-0000-7000-8000-000000000113",
      "00000000-0000-7000-8000-000000000114",
      "00000000-0000-7000-8000-000000000115",
    ];
    let calls = 0;
    const idFactory = (): string => {
      const id = generated[calls] ?? crypto.randomUUID();
      calls += 1;
      if (calls === 5) git(repository, "config", GIT_PROJECT_ID_KEY, winnerProject);
      return id;
    };
    const service =
      _name === "in-memory"
        ? await makeManagedStackService({
            repository: createInMemoryManagedStackRepository(),
            stateRoot: join(root, "managed"),
            publicationPollMs: 1,
            idFactory,
          })
        : await createManagedStackService({
            stateRoot: join(root, "managed"),
            publicationPollMs: 1,
            idFactory,
          });
    openHandles.push(service);

    await expect(service.newCheckout({ workspacePath: repository })).rejects.toMatchObject({
      _tag: "ManagedIdentityTransitionOwnershipError",
    });
    expect(storedConfigValue(gitConfigPath(join(repository, ".git")), GIT_PROJECT_ID_KEY)).toBe(
      winnerProject,
    );
    expect(existsSync(gitCheckoutIdentityPath(join(repository, ".git")))).toBe(false);
    expect(
      storedConfigValue(gitConfigPath(join(repository, ".git")), gitBranchContextIdKey("main")),
    ).toBeUndefined();
    const claims = await Effect.runPromise(service.repository.listIdentityClaims());
    expect(claims.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "new-checkout",
          phase: "reserved",
          projectId: expect.any(String),
          checkoutId: expect.any(String),
          contextId: expect.any(String),
        }),
      ]),
    );
  });

  it("completes a detached checkout whose context registry row is missing", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await open(root);
    openHandles.push(service);
    const branch = await service.resolveStack({ workspacePath: repository, operation: "start" });
    git(repository, "checkout", "-q", "--detach", "HEAD");

    const before = await inspect(service.repository, repository);
    expect(before.state).toBe("unregistered");
    expect(before.identity.projectId).toBe(branch.identity.projectId);
    expect(before.identity.checkoutId).toBe(branch.identity.checkoutId);
    expect(before.identity.contextId).toBeUndefined();
    const published = await service.newCheckout({ workspacePath: repository });

    expect(published.identity.projectId).toBe(branch.identity.projectId);
    expect(published.identity.checkoutId).toBe(branch.identity.checkoutId);
    expect(published.identity.contextId).toBeDefined();
    expect(published.state).toBe("healthy");
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

  it("supports explicit rebind of a healthy checkout", async () => {
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
  });

  it("refuses a live copied checkout when its project key is missing", async () => {
    const root = makeRoot();
    const ownerWorkspace = makeRepository(root, "owner");
    const copiedWorkspace = join(root, "copied");
    const service = await open(root);
    openHandles.push(service);
    const owner = await service.resolveStack({
      workspacePath: ownerWorkspace,
      operation: "start",
    });
    cpSync(ownerWorkspace, copiedWorkspace, { recursive: true });
    git(copiedWorkspace, "config", "--unset", GIT_PROJECT_ID_KEY);
    const copiedConfig = gitConfigPath(join(copiedWorkspace, ".git"));
    const copiedMarker = gitCheckoutIdentityPath(join(copiedWorkspace, ".git"));
    const beforeConfig = readFileSync(copiedConfig, "utf8");
    const beforeMarker = readFileSync(copiedMarker, "utf8");
    const beforeStatus = gitStatus(copiedWorkspace);
    const beforeClaims = await Effect.runPromise(service.repository.listIdentityClaims());
    const beforeStacks = await Effect.runPromise(service.repository.listStacks());
    const beforeOperations = await Effect.runPromise(service.repository.listActiveOperations());
    const beforeTree = snapshotTree(root);

    const report = await inspect(service.repository, copiedWorkspace);
    expect(report.identity).toEqual({
      checkoutId: owner.identity.checkoutId,
      contextId: owner.identity.contextId,
    });
    expect(report.state).toBe("duplicate");
    expect(report.recoveryOperations).toEqual([]);
    expect(readFileSync(copiedConfig, "utf8")).toBe(beforeConfig);
    expect(readFileSync(copiedMarker, "utf8")).toBe(beforeMarker);
    expect(gitStatus(copiedWorkspace)).toBe(beforeStatus);
    expect(await Effect.runPromise(service.repository.listIdentityClaims())).toEqual(beforeClaims);
    expect(await Effect.runPromise(service.repository.listStacks())).toEqual(beforeStacks);
    expect(await Effect.runPromise(service.repository.listActiveOperations())).toEqual(
      beforeOperations,
    );
    expect(snapshotTree(root)).toEqual(beforeTree);
  });

  it("does not advertise recovery when the active checkout project key is missing", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await open(root);
    openHandles.push(service);
    const started = await service.resolveStack({ workspacePath: repository, operation: "start" });
    git(repository, "config", "--unset", GIT_PROJECT_ID_KEY);
    const configPath = gitConfigPath(join(repository, ".git"));
    const markerPath = gitCheckoutIdentityPath(join(repository, ".git"));
    const beforeConfig = readFileSync(configPath, "utf8");
    const beforeMarker = readFileSync(markerPath, "utf8");
    const beforeStatus = gitStatus(repository);
    const beforeClaims = await Effect.runPromise(service.repository.listIdentityClaims());
    const beforeStacks = await Effect.runPromise(service.repository.listStacks());
    const beforeOperations = await Effect.runPromise(service.repository.listActiveOperations());
    const beforeTree = snapshotTree(root);

    const report = await service.discoverWorkspace(repository);
    expect(report.identity).toEqual({
      checkoutId: started.identity.checkoutId,
      contextId: started.identity.contextId,
    });
    expect(report.state).toBe("duplicate");
    expect(report.recoveryOperations).toEqual([]);
    expect(readFileSync(configPath, "utf8")).toBe(beforeConfig);
    expect(readFileSync(markerPath, "utf8")).toBe(beforeMarker);
    expect(gitStatus(repository)).toBe(beforeStatus);
    expect(await Effect.runPromise(service.repository.listIdentityClaims())).toEqual(beforeClaims);
    expect(await Effect.runPromise(service.repository.listStacks())).toEqual(beforeStacks);
    expect(await Effect.runPromise(service.repository.listActiveOperations())).toEqual(
      beforeOperations,
    );
    expect(snapshotTree(root)).toEqual(beforeTree);
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
  });

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
  });

  it("retains each probed location state when historical rows share a path", async () => {
    const root = makeRoot();
    const previous = makeRepository(root);
    const next = join(root, "shared-historical-path");
    const service = await open(root);
    openHandles.push(service);
    const first = await service.resolveStack({ workspacePath: previous, operation: "start" });
    renameSync(previous, next);
    await service.resolveStack({ workspacePath: next, operation: "start" });
    const base = service.repository;
    const wrapped: ManagedStackRepositoryShape = {
      ...base,
      listIdentityClaims: (projectId) =>
        Effect.map(base.listIdentityClaims(projectId), (claims) => ({
          ...claims,
          locations: [
            {
              id: "00000000-0000-7000-8000-000000000108",
              checkoutId: first.identity.checkoutId,
              canonicalPath: previous,
              state: "blocked" as const,
              lastSeenAt: new Date().toISOString(),
            },
            ...claims.locations,
          ],
        })),
    };

    const report = await inspect(wrapped, next);

    expect(report.historicalPathEvidence).toEqual(
      expect.arrayContaining([
        { path: previous, locationState: "blocked", probe: "missing" },
        { path: previous, locationState: "superseded", probe: "missing" },
      ]),
    );
  });

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

  it("releases a stale reserved rebind through the guarded service operation", async () => {
    const root = makeRoot();
    const previous = makeRepository(root);
    const next = join(root, "abandon-recovery");
    const service = await open(root);
    openHandles.push(service);
    const first = await service.resolveStack({ workspacePath: previous, operation: "start" });
    renameSync(previous, next);
    const reserved = await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: "00000000-0000-7000-8000-000000000103",
        kind: "rebind-checkout",
        projectId: first.identity.projectId,
        checkoutId: first.identity.checkoutId,
        path: next,
        now: new Date().toISOString(),
      }),
    );
    const report = await inspect(service.repository, next);
    expect(report.state).toBe("transitioning");
    await expect(
      service.abandonIdentityTransition({
        transitionId: reserved.id,
        workspacePath: next,
        observation: report,
      }),
    ).resolves.toEqual({ outcome: "abandoned" });
    expect((await inspect(service.repository, next)).activeTransition).toBeUndefined();
  });

  it("refuses to abandon a partially published new-checkout transition", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const projectId = "00000000-0000-7000-8000-000000000104";
    const checkoutId = "00000000-0000-7000-8000-000000000106";
    const contextId = "00000000-0000-7000-8000-000000000107";
    git(repository, "config", GIT_PROJECT_ID_KEY, projectId);
    git(repository, "config", gitBranchContextIdKey("main"), contextId);
    const service = await open(root);
    openHandles.push(service);
    const reserved = await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: "00000000-0000-7000-8000-000000000105",
        kind: "new-checkout",
        projectId,
        checkoutId,
        contextId,
        branch: "main",
        path: repository,
        targetGitValue: "00000000-0000-7000-8000-000000000107",
        now: new Date().toISOString(),
      }),
    );
    writeFileSync(
      gitCheckoutIdentityPath(join(repository, ".git")),
      JSON.stringify({ version: 1, checkoutId }),
    );
    await expect(
      service.abandonIdentityTransition({
        transitionId: reserved.id,
        workspacePath: repository,
      }),
    ).rejects.toMatchObject({ _tag: "ManagedIdentityTransitionOwnershipError" });
    expect((await inspect(service.repository, repository)).activeTransition?.id).toBe(reserved.id);
  });

  it("refuses abandonment when the same path publishes a different identity", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "different-publisher");
    const service = await open(root);
    openHandles.push(service);
    const reserved = await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: "00000000-0000-7000-8000-000000000116",
        kind: "new-checkout",
        projectId: "00000000-0000-7000-8000-000000000117",
        checkoutId: "00000000-0000-7000-8000-000000000118",
        contextId: "00000000-0000-7000-8000-000000000119",
        path: workspace,
        expectedGitValue: "topology:ordinary",
        now: new Date().toISOString(),
      }),
    );
    mkdirSync(join(workspace, ".supabase"), { recursive: true });
    writeFileSync(
      ordinaryWorkspaceIdentityPath(workspace),
      JSON.stringify({
        version: 1,
        projectId: "00000000-0000-7000-8000-000000000120",
        checkoutId: "00000000-0000-7000-8000-000000000121",
        contextId: "00000000-0000-7000-8000-000000000122",
      }),
    );
    await expect(
      service.abandonIdentityTransition({
        transitionId: reserved.id,
        workspacePath: workspace,
      }),
    ).rejects.toMatchObject({ _tag: "ManagedIdentityTransitionOwnershipError" });
    expect((await inspect(service.repository, workspace)).activeTransition?.id).toBe(reserved.id);
  });

  it("refuses abandonment after a reserved transition path is recycled", async () => {
    const root = makeRoot();
    const original = makeRepository(root);
    const moved = join(root, "recycled-transition");
    const service = await open(root);
    openHandles.push(service);
    const started = await service.resolveStack({ workspacePath: original, operation: "start" });
    renameSync(original, moved);
    const reserved = await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: "00000000-0000-7000-8000-000000000123",
        kind: "rebind-checkout",
        projectId: started.identity.projectId,
        checkoutId: started.identity.checkoutId,
        path: moved,
        now: new Date().toISOString(),
      }),
    );
    rmSync(moved, { recursive: true, force: true });
    mkdirSync(moved, { recursive: true });
    await expect(
      service.abandonIdentityTransition({
        transitionId: reserved.id,
        workspacePath: moved,
      }),
    ).rejects.toMatchObject({ _tag: "ManagedIdentityTransitionOwnershipError" });
    expect((await inspect(service.repository, moved)).activeTransition?.id).toBe(reserved.id);
  });

  it("refuses abandonment when a different Git checkout replaces the transition path", async () => {
    const root = makeRoot();
    const checkoutA = makeRepository(root, "checkout-a");
    const path = join(root, "transition-path");
    renameSync(checkoutA, path);
    const service = await open(root);
    openHandles.push(service);
    const started = await service.resolveStack({ workspacePath: path, operation: "start" });
    const movedA = join(root, "checkout-a-moved");
    renameSync(path, movedA);
    await Effect.runPromise(
      service.repository.applyCheckoutLocation({
        checkoutId: started.identity.checkoutId,
        locationId: "00000000-0000-7000-8000-000000000125",
        canonicalPath: movedA,
        now: new Date().toISOString(),
      }),
    );
    const checkoutB = makeRepository(root, "checkout-b");
    renameSync(checkoutB, path);
    const reserved = await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: "00000000-0000-7000-8000-000000000124",
        kind: "rebind-checkout",
        projectId: started.identity.projectId,
        checkoutId: started.identity.checkoutId,
        contextId: started.identity.contextId,
        path,
        branch: "main",
        now: new Date().toISOString(),
      }),
    );
    const replaced = await inspect(service.repository, path);
    expect(replaced.state).toBe("transitioning");
    expect(replaced.conflicts).toEqual([]);
    expect(replaced.workspace.checkoutKind).not.toBe("ordinary");

    await expect(
      service.abandonIdentityTransition({
        transitionId: reserved.id,
        workspacePath: path,
      }),
    ).rejects.toMatchObject({ _tag: "ManagedIdentityTransitionOwnershipError" });
    expect((await inspect(service.repository, path)).activeTransition?.id).toBe(reserved.id);
  });

  it.each([
    ["branch-copy", "00000000-0000-7000-8000-000000000126"],
    ["adopt-context", "00000000-0000-7000-8000-000000000127"],
  ] as const)("refuses %s abandonment when Git path is replaced", async (kind, transitionId) => {
    const root = makeRoot();
    const original = makeRepository(root, `${kind}-original`);
    const path = join(root, `${kind}-transition-path`);
    renameSync(original, path);
    const service = await open(root);
    openHandles.push(service);
    const started =
      kind === "adopt-context"
        ? await service.resolveStack({ workspacePath: path, operation: "start" })
        : undefined;
    if (kind === "adopt-context") git(path, "branch", "-m", "renamed");
    const replacement = makeRepository(root, `${kind}-replacement`);
    renameSync(replacement, join(root, `${kind}-replacement-moved`));
    renameSync(path, join(root, `${kind}-original-moved`));
    renameSync(join(root, `${kind}-replacement-moved`), path);
    const reserved = await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: transitionId,
        kind,
        projectId: started?.identity.projectId ?? "00000000-0000-7000-8000-000000000128",
        checkoutId: started?.identity.checkoutId ?? "00000000-0000-7000-8000-000000000129",
        contextId: started?.identity.contextId ?? "00000000-0000-7000-8000-000000000130",
        branch: kind === "adopt-context" ? "renamed" : "main",
        path,
        expectedGitValue:
          kind === "branch-copy"
            ? "00000000-0000-7000-8000-000000000130"
            : started?.identity.contextId,
        targetGitValue: kind === "branch-copy" ? "00000000-0000-7000-8000-000000000131" : undefined,
        expectedOwnerBranch: kind === "adopt-context" ? "main" : undefined,
        now: new Date().toISOString(),
      }),
    );
    const replaced = await inspect(service.repository, path);
    expect(replaced.state).toBe("transitioning");
    expect(replaced.workspace.checkoutKind).not.toBe("ordinary");
    await expect(
      service.abandonIdentityTransition({ transitionId: reserved.id, workspacePath: path }),
    ).rejects.toMatchObject({ _tag: "ManagedIdentityTransitionOwnershipError" });
    expect((await inspect(service.repository, path)).activeTransition?.id).toBe(reserved.id);
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
  });

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

  it("fails closed when an ordinary marker reuses another checkout's context", async () => {
    const root = makeRoot();
    const ownerWorkspace = makeDirectory(root, "ordinary-owner");
    const conflictingWorkspace = makeDirectory(root, "ordinary-conflict");
    const service = await open(root);
    openHandles.push(service);
    const owner = await service.resolveStack({
      workspacePath: ownerWorkspace,
      operation: "start",
    });
    const ownerMarker = JSON.parse(
      readFileSync(ordinaryWorkspaceIdentityPath(ownerWorkspace), "utf8"),
    ) as {
      readonly version: number;
      readonly projectId: string;
      readonly checkoutId: string;
      readonly contextId: string;
    };
    const conflictingMarkerPath = ordinaryWorkspaceIdentityPath(conflictingWorkspace);
    mkdirSync(dirname(conflictingMarkerPath), { recursive: true });
    writeFileSync(
      conflictingMarkerPath,
      `${JSON.stringify({
        ...ownerMarker,
        checkoutId: "00000000-0000-7000-8000-000000000096",
      })}\n`,
    );
    const beforeClaims = await Effect.runPromise(service.repository.listIdentityClaims());
    const beforeStacks = await Effect.runPromise(service.repository.listStacks());
    const beforeOperations = await Effect.runPromise(service.repository.listActiveOperations());
    const beforeTree = snapshotTree(root);
    const beforeMarker = readFileSync(conflictingMarkerPath, "utf8");

    const report = await inspect(service.repository, conflictingWorkspace);
    expect(report.identity).toEqual({
      projectId: owner.identity.projectId,
      checkoutId: "00000000-0000-7000-8000-000000000096",
      contextId: owner.identity.contextId,
    });
    expect(report.state).toBe("duplicate");
    expect(report.recoveryOperations).toEqual([]);
    await expect(
      service.resolveStack({ workspacePath: conflictingWorkspace, operation: "start" }),
    ).rejects.toMatchObject({ _tag: "ManagedCheckoutConflictError" });
    expect(await Effect.runPromise(service.repository.listIdentityClaims())).toEqual(beforeClaims);
    expect(await Effect.runPromise(service.repository.listStacks())).toEqual(beforeStacks);
    expect(await Effect.runPromise(service.repository.listActiveOperations())).toEqual(
      beforeOperations,
    );
    expect(snapshotTree(root)).toEqual(beforeTree);
    expect(readFileSync(conflictingMarkerPath, "utf8")).toBe(beforeMarker);
  });

  it("fails closed when Git project and checkout markers belong to different projects", async () => {
    const root = makeRoot();
    const workspace = makeRepository(root, "checkout-project");
    const contextWorkspace = makeRepository(root, "context-project");
    const service = await open(root);
    openHandles.push(service);
    const checkoutOwner = await service.resolveStack({
      workspacePath: workspace,
      operation: "start",
    });
    const contextOwner = await service.resolveStack({
      workspacePath: contextWorkspace,
      operation: "start",
    });
    expect(contextOwner.identity.projectId).not.toBe(checkoutOwner.identity.projectId);
    git(workspace, "config", GIT_PROJECT_ID_KEY, contextOwner.identity.projectId);
    git(workspace, "config", gitBranchContextIdKey("main"), contextOwner.identity.contextId);

    const calls = { count: 0 };
    const guardedRepository = mutationDenied(service.repository, calls);
    const guardedRoot = join(root, "inconsistent-identity-managed");
    const guarded = await makeManagedStackService({
      repository: guardedRepository,
      stateRoot: guardedRoot,
      publicationPollMs: 1,
    });
    openHandles.push(guarded);
    const beforeClaims = await Effect.runPromise(service.repository.listIdentityClaims());
    const beforeStacks = await Effect.runPromise(service.repository.listStacks());
    const beforeOperations = await Effect.runPromise(service.repository.listActiveOperations());
    const beforeTree = snapshotTree(guardedRoot);

    const report = await inspect(guardedRepository, workspace);
    expect(report.identity).toEqual({
      projectId: contextOwner.identity.projectId,
      checkoutId: checkoutOwner.identity.checkoutId,
      contextId: contextOwner.identity.contextId,
    });
    expect(report.state).toBe("duplicate");
    expect(report.recoveryOperations).toEqual([]);
    await expect(
      guarded.resolveStack({ workspacePath: workspace, operation: "start" }),
    ).rejects.toMatchObject({ _tag: "ManagedCheckoutConflictError" });
    expect(calls.count).toBe(0);
    expect(await Effect.runPromise(service.repository.listIdentityClaims())).toEqual(beforeClaims);
    expect(await Effect.runPromise(service.repository.listStacks())).toEqual(beforeStacks);
    expect(await Effect.runPromise(service.repository.listActiveOperations())).toEqual(
      beforeOperations,
    );
    expect(snapshotTree(guardedRoot)).toEqual(beforeTree);
  });

  it("recovers when the active location is missing", async () => {
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
    expect(report.state).toBe("moved");
    expect(report.recoveryOperations).toEqual([
      {
        operation: "rebindCheckout",
        checkoutId: started.identity.checkoutId,
        path: workspace,
      },
    ]);

    const recovered = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    expect(recovered.identity).toEqual(started.identity);
    expect(recovered.stack.id).toBe(started.stack.id);

    const healthy = await inspect(service.repository, workspace);
    expect(healthy.state).toBe("healthy");
    const locations = (
      await Effect.runPromise(service.repository.listIdentityClaims())
    ).locations.filter((location) => location.checkoutId === started.identity.checkoutId);
    expect(locations.filter((location) => location.state === "active")).toEqual([
      expect.objectContaining({ canonicalPath: workspace }),
    ]);
    expect(locations.filter((location) => location.state === "blocked")).toEqual([]);
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

  it("migrates one exact ordinary-folder claim into Git without touching a tracked marker", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "folder-to-git");
    const service = await open(root);
    openHandles.push(service);
    const ordinary = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    git(workspace, "init", "-q", "-b", "main");
    git(workspace, "add", ".supabase/identity.json");
    git(workspace, "commit", "-q", "-m", "track ordinary identity");
    const beforeStatus = gitStatus(workspace);
    const migrated = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    expect(migrated.identity).toEqual(ordinary.identity);
    expect(migrated.stack.id).toBe(ordinary.stack.id);
    expect(gitStatus(workspace)).toBe(beforeStatus);
    const report = await inspect(service.repository, workspace);
    expect(report.state).toBe("healthy");
    expect(report.identity).toEqual(ordinary.identity);
    expect(report.ordinaryMarker?.present).toBe(true);
    expect(report.warnings).toContain(
      "Tracked ordinary-folder identity marker is inert in this Git checkout",
    );
    expect(report.folderToGitClaims).toEqual([]);
    expect(git(workspace, "config", "--get", "supabase.projectId").trim()).toBe(
      ordinary.identity.projectId,
    );
  });

  it("keeps a stale ordinary claim as a conflict after an unrelated Git checkout replaces the path", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "recycled-folder-to-git");
    const service = await open(root);
    openHandles.push(service);
    await service.resolveStack({ workspacePath: workspace, operation: "start" });
    const beforeStacks = await service.listStacks();
    const beforeClaims = await Effect.runPromise(service.repository.listIdentityClaims());

    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    git(workspace, "init", "-q", "-b", "unrelated");

    const report = await inspect(service.repository, workspace);
    expect(report.state).toBe("duplicate");
    expect(report.conflictingLocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalPath: workspace,
          checkoutId: beforeClaims.locations[0]?.checkoutId,
        }),
      ]),
    );
    await expect(
      service.resolveStack({ workspacePath: workspace, operation: "start" }),
    ).rejects.toMatchObject({ _tag: "InvalidManagedIdentityError" });
    expect(await service.listStacks()).toEqual(beforeStacks);
    expect(await Effect.runPromise(service.repository.listIdentityClaims())).toEqual(beforeClaims);
  });

  it("migrates an ordinary claim from a nested caller using the Git checkout root marker", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "nested-folder-to-git");
    const nested = makeDirectory(workspace, "nested");
    const service = await open(root);
    openHandles.push(service);
    const ordinary = await service.resolveStack({ workspacePath: workspace, operation: "start" });

    git(workspace, "init", "-q", "-b", "main");
    const migrated = await service.resolveStack({ workspacePath: nested, operation: "start" });

    expect(migrated.identity).toEqual(ordinary.identity);
    expect(migrated.stack.id).toBe(ordinary.stack.id);
    expect((await inspect(service.repository, nested)).state).toBe("healthy");
  });

  it("resumes detached folder-to-Git migration with the original context and marker", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "detached-folder-to-git");
    const service = await open(root);
    openHandles.push(service);
    const ordinary = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    const markerPath = ordinaryWorkspaceIdentityPath(workspace);
    git(workspace, "init", "-q", "-b", "main");
    git(workspace, "add", ".supabase/identity.json");
    git(workspace, "commit", "-q", "-m", "track ordinary identity");
    git(workspace, "checkout", "-q", "--detach", "HEAD");
    const markerBefore = readFileSync(markerPath, "utf8");
    const indexBefore = git(workspace, "ls-files", "--stage", ".supabase/identity.json");
    const statusBefore = gitStatus(workspace);
    let interruptRegistration = true;
    const repository: ManagedStackRepositoryShape = {
      ...service.repository,
      registerCheckoutIdentity: (input) => {
        if (!interruptRegistration) return service.repository.registerCheckoutIdentity(input);
        interruptRegistration = false;
        return Effect.fail(
          new ManagedIdentityTransitionOwnershipError({ transitionId: "injected-interruption" }),
        );
      },
    };
    const recovering = await makeManagedStackService({
      repository,
      stateRoot: join(root, "detached-recovery-managed"),
      publicationPollMs: 1,
    });
    openHandles.push(recovering);

    await expect(
      recovering.resolveStack({ workspacePath: workspace, operation: "start" }),
    ).rejects.toMatchObject({ _tag: "ManagedIdentityTransitionOwnershipError" });
    const interruptedClaims = await Effect.runPromise(service.repository.listIdentityClaims());
    expect(
      interruptedClaims.contexts.find((context) => context.id === ordinary.identity.contextId),
    ).toMatchObject({
      id: ordinary.identity.contextId,
      checkoutId: ordinary.identity.checkoutId,
      kind: "detached",
    });
    expect(interruptedClaims.transitions).toContainEqual(
      expect.objectContaining({ kind: "folder-to-git", phase: "git-written" }),
    );
    expect(readFileSync(markerPath, "utf8")).toBe(markerBefore);
    expect(git(workspace, "ls-files", "--stage", ".supabase/identity.json")).toBe(indexBefore);
    expect(gitStatus(workspace)).toBe(statusBefore);

    const migrated = await recovering.resolveStack({
      workspacePath: workspace,
      operation: "start",
    });
    expect(migrated.identity).toEqual(ordinary.identity);
    expect(migrated.stack.id).toBe(ordinary.stack.id);
    expect(migrated.context.kind).toBe("detached");
    expect(await recovering.inspectStack(ordinary.stack.id)).toMatchObject({
      contextKind: "detached",
    });
    const report = await inspect(service.repository, workspace);
    expect(report.state).toBe("healthy");
    expect(report.identity).toEqual(ordinary.identity);
    expect(report.activeTransition).toBeUndefined();
    expect(report.folderToGitClaims).toEqual([]);
    expect(readFileSync(markerPath, "utf8")).toBe(markerBefore);
    expect(git(workspace, "ls-files", "--stage", ".supabase/identity.json")).toBe(indexBefore);
    expect(gitStatus(workspace)).toBe(statusBefore);
  });

  it("creates fresh Git identities when only a tracked marker exists in a clone", async () => {
    const root = makeRoot();
    const source = makeDirectory(root, "source-folder");
    const sourceService = await open(root);
    openHandles.push(sourceService);
    const ordinary = await sourceService.resolveStack({
      workspacePath: source,
      operation: "start",
    });
    git(source, "init", "-q", "-b", "main");
    git(source, "add", ".supabase/identity.json");
    git(source, "commit", "-q", "-m", "track ordinary identity");
    const clone = join(root, "fresh-clone");
    git(root, "clone", "-q", source, clone);
    const cloneService = await open(root);
    openHandles.push(cloneService);
    const beforeStatus = gitStatus(clone);
    const fresh = await cloneService.resolveStack({ workspacePath: clone, operation: "start" });
    expect(fresh.identity.projectId).not.toBe(ordinary.identity.projectId);
    expect(fresh.identity.checkoutId).not.toBe(ordinary.identity.checkoutId);
    expect(gitStatus(clone)).toBe(beforeStatus);
    expect((await inspect(cloneService.repository, clone)).ordinaryMarker?.present).toBe(true);
  });

  it("refuses ambiguous exact folder claims before any Git or registry write", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "ambiguous-folder-to-git");
    const service = await open(root);
    openHandles.push(service);
    const ordinary = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    git(workspace, "init", "-q", "-b", "main");
    const base = service.repository;
    const claimTime = new Date().toISOString();
    const ambiguous: ManagedStackRepositoryShape = {
      ...base,
      listIdentityClaims: (projectId) =>
        Effect.map(base.listIdentityClaims(projectId), (claims) => ({
          ...claims,
          locations: [
            ...claims.locations,
            {
              id: "00000000-0000-7000-8000-000000000098",
              checkoutId: "00000000-0000-7000-8000-000000000099",
              canonicalPath: workspace,
              state: "active" as const,
              lastSeenAt: claimTime,
            },
            {
              id: "00000000-0000-7000-8000-000000000097",
              checkoutId: ordinary.identity.checkoutId,
              canonicalPath: workspace,
              state: "active" as const,
              lastSeenAt: claimTime,
            },
          ],
          contexts: [
            ...claims.contexts,
            {
              id: "00000000-0000-7000-8000-000000000099",
              projectId: ordinary.identity.projectId,
              checkoutId: "00000000-0000-7000-8000-000000000099",
              kind: "workspace" as const,
              createdAt: claimTime,
            },
          ],
        })),
    };
    const guarded = await makeManagedStackService({
      repository: ambiguous,
      stateRoot: join(root, "ambiguous-managed"),
      publicationPollMs: 1,
    });
    openHandles.push(guarded);
    const before = gitStatus(workspace);
    const beforeStacks = await guarded.listStacks();
    await expect(
      guarded.resolveStack({ workspacePath: workspace, operation: "start" }),
    ).rejects.toMatchObject({
      _tag: "ManagedCheckoutConflictError",
    });
    expect(gitStatus(workspace)).toBe(before);
    expect(await guarded.listStacks()).toEqual(beforeStacks);
  });

  it("refuses a git-written transition when Git targets are missing", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "git-written-missing-targets");
    const service = await open(root);
    openHandles.push(service);
    const ordinary = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    git(workspace, "init", "-q", "-b", "main");
    const transitionId = "00000000-0000-7000-8000-000000000091";
    await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: transitionId,
        kind: "folder-to-git",
        projectId: ordinary.identity.projectId,
        checkoutId: ordinary.identity.checkoutId,
        contextId: ordinary.identity.contextId,
        branch: "main",
        path: workspace,
        expectedGitValue: "absent",
        targetGitValue: ordinary.identity.contextId,
        now: new Date().toISOString(),
      }),
    );
    await Effect.runPromise(
      service.repository.advanceIdentityTransition({
        id: transitionId,
        expectedPhase: "reserved",
        phase: "git-written",
        now: new Date().toISOString(),
      }),
    );
    const beforeConfig = readFileSync(join(workspace, ".git", "config"), "utf8");
    await expect(
      service.resolveStack({ workspacePath: workspace, operation: "start" }),
    ).rejects.toMatchObject({ _tag: "ManagedIdentityTransitionOwnershipError" });
    expect(readFileSync(join(workspace, ".git", "config"), "utf8")).toBe(beforeConfig);
    expect(existsSync(gitCheckoutIdentityPath(join(workspace, ".git")))).toBe(false);
  });

  it("never overwrites a competing Git project or branch winner", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "git-config-winner");
    const service = await open(root);
    openHandles.push(service);
    await service.resolveStack({ workspacePath: workspace, operation: "start" });
    git(workspace, "init", "-q", "-b", "main");
    const competingProject = "00000000-0000-7000-8000-000000000102";
    const competingContext = "00000000-0000-7000-8000-000000000103";
    const base = service.repository;
    let raced = false;
    const wrapped: ManagedStackRepositoryShape = {
      ...base,
      reserveIdentityTransition: (input) =>
        Effect.tap(base.reserveIdentityTransition(input), () =>
          Effect.sync(() => {
            if (!raced) {
              raced = true;
              git(workspace, "config", GIT_PROJECT_ID_KEY, competingProject);
              git(workspace, "config", gitBranchContextIdKey("main"), competingContext);
            }
          }),
        ),
    };
    const guarded = await makeManagedStackService({
      repository: wrapped,
      stateRoot: join(root, "git-config-winner-managed"),
      publicationPollMs: 1,
    });
    openHandles.push(guarded);
    const beforeConfig = readFileSync(join(workspace, ".git", "config"), "utf8");
    const beforeStatus = gitStatus(workspace);
    const beforeStacks = await guarded.listStacks();
    await expect(
      guarded.resolveStack({ workspacePath: workspace, operation: "start" }),
    ).rejects.toMatchObject({ _tag: "ManagedIdentityTransitionOwnershipError" });
    expect(readFileSync(join(workspace, ".git", "config"), "utf8")).not.toBe(beforeConfig);
    expect(gitStatus(workspace)).toBe(beforeStatus);
    expect(git(workspace, "config", GIT_PROJECT_ID_KEY).trim()).toBe(competingProject);
    expect(git(workspace, "config", gitBranchContextIdKey("main")).trim()).toBe(competingContext);
    expect(existsSync(gitCheckoutIdentityPath(join(workspace, ".git")))).toBe(false);
    expect(await guarded.listStacks()).toEqual(beforeStacks);
  });

  it("does not treat an undefined branch binding as a wildcard", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "branch-binding-mismatch");
    const service = await open(root);
    openHandles.push(service);
    const ordinary = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    git(workspace, "init", "-q", "-b", "main");
    const transitionId = "00000000-0000-7000-8000-000000000092";
    await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: transitionId,
        kind: "folder-to-git",
        projectId: ordinary.identity.projectId,
        checkoutId: ordinary.identity.checkoutId,
        contextId: ordinary.identity.contextId,
        path: workspace,
        expectedGitValue: "absent",
        targetGitValue: ordinary.identity.contextId,
        now: new Date().toISOString(),
      }),
    );
    await expect(
      service.resolveStack({ workspacePath: workspace, operation: "start" }),
    ).rejects.toMatchObject({ _tag: "ManagedIdentityTransitionOwnershipError" });
    expect(existsSync(gitCheckoutIdentityPath(join(workspace, ".git")))).toBe(false);
  });

  it("refuses a duplicate current path before publishing Git identity", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "duplicate-current-path");
    const service = await open(root);
    openHandles.push(service);
    await service.resolveStack({ workspacePath: workspace, operation: "start" });
    git(workspace, "init", "-q", "-b", "main");
    const base = service.repository;
    const foreignCheckoutId = "00000000-0000-7000-8000-000000000093";
    const wrapped: ManagedStackRepositoryShape = {
      ...base,
      listIdentityClaims: (projectId) =>
        Effect.map(base.listIdentityClaims(projectId), (claims) => ({
          ...claims,
          locations: [
            ...claims.locations,
            {
              id: "00000000-0000-7000-8000-000000000094",
              checkoutId: foreignCheckoutId,
              canonicalPath: workspace,
              state: "active" as const,
              lastSeenAt: new Date().toISOString(),
            },
          ],
        })),
    };
    const guarded = await makeManagedStackService({
      repository: wrapped,
      stateRoot: join(root, "duplicate-managed"),
      publicationPollMs: 1,
    });
    openHandles.push(guarded);
    const beforeConfig = readFileSync(join(workspace, ".git", "config"), "utf8");
    const beforeStacks = await guarded.listStacks();
    await expect(
      guarded.resolveStack({ workspacePath: workspace, operation: "start" }),
    ).rejects.toMatchObject({ _tag: "InvalidManagedIdentityError" });
    expect(readFileSync(join(workspace, ".git", "config"), "utf8")).toBe(beforeConfig);
    expect(existsSync(gitCheckoutIdentityPath(join(workspace, ".git")))).toBe(false);
    expect(await guarded.listStacks()).toEqual(beforeStacks);
  });

  it("refuses when the exact ordinary claim changes after transition reservation", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "claim-race");
    const service = await open(root);
    openHandles.push(service);
    const ordinary = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    git(workspace, "init", "-q", "-b", "main");
    let reserved = false;
    const base = service.repository;
    const wrapped: ManagedStackRepositoryShape = {
      ...base,
      reserveIdentityTransition: (input) =>
        Effect.tap(base.reserveIdentityTransition(input), () =>
          Effect.sync(() => {
            reserved = true;
          }),
        ),
      listIdentityClaims: (projectId) =>
        Effect.map(base.listIdentityClaims(projectId), (claims) =>
          reserved
            ? {
                ...claims,
                contexts: claims.contexts.filter(
                  (context) => context.id !== ordinary.identity.contextId,
                ),
              }
            : claims,
        ),
    };
    const guarded = await makeManagedStackService({
      repository: wrapped,
      stateRoot: join(root, "claim-race-managed"),
      publicationPollMs: 1,
    });
    openHandles.push(guarded);
    const beforeConfig = readFileSync(join(workspace, ".git", "config"), "utf8");
    await expect(
      guarded.resolveStack({ workspacePath: workspace, operation: "start" }),
    ).rejects.toMatchObject({ _tag: "ManagedIdentityTransitionOwnershipError" });
    expect(readFileSync(join(workspace, ".git", "config"), "utf8")).toBe(beforeConfig);
    expect(existsSync(gitCheckoutIdentityPath(join(workspace, ".git")))).toBe(false);
  });

  it("refuses a complete Git identity when a foreign ordinary claim shares its path", async () => {
    const root = makeRoot();
    const workspace = makeRepository(root, "complete-git");
    const service = await open(root);
    openHandles.push(service);
    const started = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    const base = service.repository;
    const foreignCheckoutId = "00000000-0000-7000-8000-000000000095";
    const foreignProjectId = "00000000-0000-7000-8000-000000000096";
    const foreignContextId = "00000000-0000-7000-8000-000000000097";
    const staleTime = new Date().toISOString();
    const wrapped: ManagedStackRepositoryShape = {
      ...base,
      listIdentityClaims: (projectId) =>
        Effect.map(base.listIdentityClaims(projectId), (claims) => ({
          ...claims,
          locations:
            projectId === undefined
              ? [
                  ...claims.locations,
                  {
                    id: "00000000-0000-7000-8000-000000000098",
                    checkoutId: foreignCheckoutId,
                    canonicalPath: workspace,
                    state: "active" as const,
                    lastSeenAt: staleTime,
                  },
                ]
              : claims.locations,
          contexts:
            projectId === undefined
              ? [
                  ...claims.contexts,
                  {
                    id: foreignContextId,
                    projectId: foreignProjectId,
                    checkoutId: foreignCheckoutId,
                    kind: "workspace" as const,
                    createdAt: staleTime,
                  },
                ]
              : claims.contexts,
        })),
    };
    const guarded = await makeManagedStackService({
      repository: wrapped,
      stateRoot: join(root, "complete-git-managed"),
      publicationPollMs: 1,
    });
    openHandles.push(guarded);
    const beforeConfig = readFileSync(join(workspace, ".git", "config"), "utf8");
    const beforeStacks = await guarded.listStacks();
    const beforeClaims = await Effect.runPromise(guarded.repository.listIdentityClaims());
    const report = await inspect(wrapped, workspace);
    expect(report.state).toBe("duplicate");
    expect(report.conflictingLocations).toEqual([
      expect.objectContaining({ checkoutId: foreignCheckoutId, canonicalPath: workspace }),
    ]);
    await expect(
      guarded.resolveStack({ workspacePath: workspace, operation: "start" }),
    ).rejects.toMatchObject({ _tag: "ManagedCheckoutConflictError" });
    expect(readFileSync(join(workspace, ".git", "config"), "utf8")).toBe(beforeConfig);
    expect(await guarded.listStacks()).toEqual(beforeStacks);
    expect(await Effect.runPromise(guarded.repository.listIdentityClaims())).toEqual(beforeClaims);
    expect(report.identity).toEqual(started.identity);
  });

  it("reports a global Git path collision and refuses start without mutation", async () => {
    const root = makeRoot();
    const workspace = makeRepository(root, "global-path-collision");
    const service = await open(root);
    openHandles.push(service);
    const started = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    const foreignProjectId = "00000000-0000-7000-8000-000000000201";
    const foreignCheckoutId = "00000000-0000-7000-8000-000000000202";
    const foreignContextId = "00000000-0000-7000-8000-000000000203";
    const claimedAt = new Date().toISOString();
    const base = service.repository;
    const globalClaims: ManagedStackRepositoryShape = {
      ...base,
      listIdentityClaims: (projectId) =>
        Effect.map(base.listIdentityClaims(projectId), (claims) =>
          projectId === undefined
            ? {
                ...claims,
                locations: [
                  ...claims.locations,
                  {
                    id: "00000000-0000-7000-8000-000000000204",
                    checkoutId: foreignCheckoutId,
                    canonicalPath: workspace,
                    state: "active" as const,
                    lastSeenAt: claimedAt,
                  },
                ],
                contexts: [
                  ...claims.contexts,
                  {
                    id: foreignContextId,
                    projectId: foreignProjectId,
                    checkoutId: foreignCheckoutId,
                    kind: "branch" as const,
                    locator: "foreign",
                    ownerBranch: "foreign",
                    createdAt: claimedAt,
                  },
                ],
              }
            : claims,
        ),
    };
    const beforeClaims = await Effect.runPromise(base.listIdentityClaims());
    const beforeStacks = await service.listStacks();
    const markerPath = gitCheckoutIdentityPath(join(workspace, ".git"));
    const configPath = gitConfigPath(join(workspace, ".git"));
    const beforeMarker = readFileSync(markerPath, "utf8");
    const beforeConfig = readFileSync(configPath, "utf8");
    const guarded = await makeManagedStackService({
      repository: mutationDenied(globalClaims, { count: 0 }),
      stateRoot: join(root, "global-path-collision-managed"),
      publicationPollMs: 1,
    });
    openHandles.push(guarded);

    const report = await inspect(globalClaims, workspace);
    expect(report.state).toBe("duplicate");
    expect(report.conflictingLocations).toEqual([
      expect.objectContaining({ checkoutId: foreignCheckoutId, canonicalPath: workspace }),
    ]);
    await expect(
      guarded.resolveStack({ workspacePath: workspace, operation: "start" }),
    ).rejects.toMatchObject({
      _tag: "ManagedCheckoutConflictError",
    });
    expect(readFileSync(markerPath, "utf8")).toBe(beforeMarker);
    expect(readFileSync(configPath, "utf8")).toBe(beforeConfig);
    expect(await Effect.runPromise(base.listIdentityClaims())).toEqual(beforeClaims);
    expect(await service.listStacks()).toEqual(beforeStacks);
    expect(started.identity.checkoutId).toBeDefined();
  });

  it("finalizes after a crash that migrated registry context and location", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "crash-after-registry");
    const service = await open(root);
    openHandles.push(service);
    const ordinary = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    git(workspace, "init", "-q", "-b", "main");
    const gitDirectory = join(workspace, ".git");
    git(workspace, "config", GIT_PROJECT_ID_KEY, ordinary.identity.projectId);
    git(workspace, "config", gitBranchContextIdKey("main"), ordinary.identity.contextId);
    writeFileSync(
      gitCheckoutIdentityPath(gitDirectory),
      `${JSON.stringify({ version: 1, checkoutId: ordinary.identity.checkoutId })}\n`,
    );
    const transitionId = "00000000-0000-7000-8000-000000000099";
    await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: transitionId,
        kind: "folder-to-git",
        projectId: ordinary.identity.projectId,
        checkoutId: ordinary.identity.checkoutId,
        contextId: ordinary.identity.contextId,
        branch: "main",
        path: workspace,
        expectedGitValue: "absent",
        targetGitValue: ordinary.identity.contextId,
        now: new Date().toISOString(),
      }),
    );
    await Effect.runPromise(
      service.repository.advanceIdentityTransition({
        id: transitionId,
        expectedPhase: "reserved",
        phase: "git-written",
        now: new Date().toISOString(),
      }),
    );
    await Effect.runPromise(
      service.repository.migrateContextToBranch({
        contextId: ordinary.identity.contextId,
        projectId: ordinary.identity.projectId,
        checkoutId: ordinary.identity.checkoutId,
        branch: "main",
        now: new Date().toISOString(),
      }),
    );
    await Effect.runPromise(
      service.repository.registerCheckoutIdentity({
        identity: ordinary.identity,
        checkoutKind: "git",
        checkoutRootPath: workspace,
        locationId: "00000000-0000-7000-8000-000000000100",
        context: { kind: "branch", locator: "main" },
        now: new Date().toISOString(),
      }),
    );
    const resumed = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    expect(resumed.outcome).toBe("reuse");
    expect(resumed.identity).toEqual(ordinary.identity);
    expect((await inspect(service.repository, workspace)).activeTransition).toBeUndefined();
  });

  it("resumes an interrupted folder-to-Git transition only for its exact path and claim", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "interrupted-folder-to-git");
    const service = await open(root);
    openHandles.push(service);
    const ordinary = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    git(workspace, "init", "-q", "-b", "main");
    await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: "00000000-0000-7000-8000-000000000096",
        kind: "folder-to-git",
        projectId: ordinary.identity.projectId,
        checkoutId: ordinary.identity.checkoutId,
        contextId: ordinary.identity.contextId,
        branch: "main",
        path: workspace,
        expectedGitValue: "absent",
        targetGitValue: ordinary.identity.contextId,
        now: new Date().toISOString(),
      }),
    );
    const interrupted = await inspect(service.repository, workspace);
    expect(interrupted.state).toBe("transitioning");
    const resumed = await service.resolveStack({ workspacePath: workspace, operation: "start" });
    expect(resumed.identity).toEqual(ordinary.identity);
    expect(resumed.stack.id).toBe(ordinary.stack.id);
    expect((await inspect(service.repository, workspace)).activeTransition).toBeUndefined();
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

  it("abandons an interrupted renamed-branch adoption while the previous owner is still current", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await open(root);
    openHandles.push(service);
    const started = await service.resolveStack({ workspacePath: repository, operation: "start" });
    git(repository, "branch", "-m", "renamed");
    let interrupt = true;
    const wrapped: ManagedStackRepositoryShape = {
      ...service.repository,
      refreshContextOwner: (input) =>
        interrupt
          ? ((interrupt = false),
            Effect.fail(new ManagedCopiedBranchConflictError({ branch: input.ownerBranch })))
          : service.repository.refreshContextOwner(input),
    };
    const recovering = await makeManagedStackService({
      repository: wrapped,
      stateRoot: join(root, "adopt-abandon-managed"),
      publicationPollMs: 1,
    });
    openHandles.push(recovering);
    const report = await recovering.discoverWorkspace(repository);
    expect(report.state).toBe("adoptable");
    await expect(
      recovering.adoptContext({ workspacePath: repository, observation: report }),
    ).rejects.toMatchObject({ _tag: "ManagedCopiedBranchConflictError" });

    const interrupted = await inspect(service.repository, repository);
    const transition = interrupted.activeTransition;
    expect(transition).toMatchObject({
      kind: "adopt-context",
      phase: "reserved",
      expectedOwnerBranch: "main",
      branch: "renamed",
    });
    expect(
      (await Effect.runPromise(service.repository.listIdentityClaims())).contexts.find(
        (context) => context.id === started.identity.contextId,
      )?.ownerBranch,
    ).toBe("main");

    await expect(
      recovering.abandonIdentityTransition({
        transitionId: transition?.id ?? "missing-transition",
        workspacePath: repository,
      }),
    ).resolves.toEqual({ outcome: "abandoned" });
    expect((await inspect(service.repository, repository)).activeTransition).toBeUndefined();
  });

  it("resumes renamed-branch adoption after owner refresh succeeds but transition advancement is interrupted", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await open(root);
    openHandles.push(service);
    const started = await service.resolveStack({ workspacePath: repository, operation: "start" });
    git(repository, "branch", "-m", "renamed");
    let interrupt = true;
    const wrapped: ManagedStackRepositoryShape = {
      ...service.repository,
      advanceIdentityTransition: (input) =>
        interrupt
          ? ((interrupt = false),
            Effect.fail(new ManagedIdentityTransitionOwnershipError({ transitionId: input.id })))
          : service.repository.advanceIdentityTransition(input),
    };
    const recovering = await makeManagedStackService({
      repository: wrapped,
      stateRoot: join(root, "adopt-resume-managed"),
      publicationPollMs: 1,
    });
    openHandles.push(recovering);
    await expect(recovering.adoptContext({ workspacePath: repository })).rejects.toMatchObject({
      _tag: "ManagedIdentityTransitionOwnershipError",
    });

    const interrupted = await inspect(service.repository, repository);
    const transition = interrupted.activeTransition;
    expect(transition).toMatchObject({
      kind: "adopt-context",
      phase: "reserved",
      expectedOwnerBranch: "main",
      branch: "renamed",
    });
    expect(
      (await Effect.runPromise(service.repository.listIdentityClaims())).contexts.find(
        (context) => context.id === started.identity.contextId,
      )?.ownerBranch,
    ).toBe("renamed");

    await expect(recovering.adoptContext({ workspacePath: repository })).resolves.toMatchObject({
      state: "healthy",
      ownerEvidence: { authoritativeOwnerBranch: "renamed" },
    });
    expect((await inspect(service.repository, repository)).activeTransition).toBeUndefined();
  });

  it.each(["renamed", "foreign"] as const)(
    "rejects renamed-branch adoption when the context owner changes to %s before reservation",
    async (ownerBranch) => {
      const root = makeRoot();
      const repository = makeRepository(root);
      const service = await open(root);
      openHandles.push(service);
      const started = await service.resolveStack({ workspacePath: repository, operation: "start" });
      git(repository, "branch", "-m", "renamed");
      const wrapped: ManagedStackRepositoryShape = {
        ...service.repository,
        reserveIdentityTransition: (input) =>
          Effect.gen(function* () {
            yield* service.repository.refreshContextOwner({
              contextId: started.identity.contextId,
              ownerBranch,
              locator: ownerBranch,
              now: new Date().toISOString(),
            });
            return yield* service.repository.reserveIdentityTransition(input);
          }),
      };
      const recovering = await makeManagedStackService({
        repository: wrapped,
        stateRoot: join(root, `adopt-owner-${ownerBranch}-managed`),
        publicationPollMs: 1,
      });
      openHandles.push(recovering);
      const report = await recovering.discoverWorkspace(repository);
      await expect(
        recovering.adoptContext({ workspacePath: repository, observation: report }),
      ).rejects.toMatchObject({ _tag: "ManagedIdentityTransitionOwnershipError" });
      expect((await inspect(service.repository, repository)).activeTransition).toBeUndefined();
    },
  );

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
