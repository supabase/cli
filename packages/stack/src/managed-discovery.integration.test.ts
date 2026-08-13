import { BunFileSystem } from "@effect/platform-bun";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { symlinkSync } from "node:fs";
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
    ).rejects.toMatchObject({ _tag: "InvalidManagedIdentityError" });
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
    ).rejects.toMatchObject({ _tag: "InvalidManagedIdentityError" });
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
    await expect(
      service.resolveStack({ workspacePath: repository, operation: "start" }),
    ).rejects.toMatchObject({ _tag: "InvalidManagedIdentityError" });
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
});
