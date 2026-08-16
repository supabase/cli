import { cpSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  git,
  makeBareRepository,
  makeDirectory,
  makeRepository,
  storedConfigValue,
  temporaryRoots,
} from "../tests/helpers/git-workspace.ts";
import { managedStackContractFixtures } from "./managed-stack-contract.ts";
import {
  GIT_PROJECT_ID_KEY,
  gitBranchContextIdKey,
  gitCheckoutIdentityPath,
  gitConfigPath,
  ManagedExactPortOccupiedError,
  InvalidManagedStackNameError,
  ManagedIdentityTransitionOwnershipError,
  type ManagedStackRepositoryShape,
  type ManagedStackServiceHandle,
  type ResolveManagedStackRequest,
} from "./managed-bun.ts";
import { createManagedStackService, makeManagedStackService } from "./managed-bun.ts";
import { createInMemoryManagedStackRepository } from "./managed/repository-memory.ts";

/**
 * `resolveStack` against real git repositories: the isolation guarantees the
 * managed layer exists to provide, stated as the workspace shapes that can break
 * them.
 *
 * A sibling worktree, a branch shared by two checkouts, a bare repository's
 * worktrees, a detached `HEAD`, and several named stacks in one context are all
 * *nearly* the same workspace, and every one of them must resolve to its own
 * stack — or deliberately to the same one. None of that can be observed against a
 * stubbed git, so these run against repositories the git binary builds, through
 * both registry adapters.
 */

const { makeRoot, removeAll } = temporaryRoots("managed-resolve-test-");

const openHandles: Array<ManagedStackServiceHandle> = [];

afterEach(async () => {
  for (const handle of openHandles.splice(0)) {
    await handle.close();
  }
  removeAll();
});

/** Both adapters owe identical observable semantics, so every case runs on both. */
const adapters = [
  [
    "in-memory",
    (root: string): Promise<ManagedStackServiceHandle> =>
      makeManagedStackService({
        repository: createInMemoryManagedStackRepository(),
        stateRoot: join(root, "managed"),
        publicationPollMs: 1,
      }),
  ],
  [
    "sqlite",
    (root: string): Promise<ManagedStackServiceHandle> =>
      createManagedStackService({ stateRoot: join(root, "managed"), publicationPollMs: 1 }),
  ],
] as const;

const defaultPortDocument = { activeFields: [] } as const;
const defaultInitialize = async (): Promise<{
  readonly processIds: Readonly<Record<string, number>>;
  readonly containerIds: Readonly<Record<string, string>>;
}> => ({ processIds: {}, containerIds: {} });

describe("resolveStack identity publication", () => {
  it("accepts a monotonic partial identity published between discovery passes", async () => {
    const root = makeRoot();
    const repositoryPath = makeRepository(root);
    const projectId = "00000000-0000-7000-8000-000000000116";
    const baseRepository = createInMemoryManagedStackRepository();
    let injected = false;
    const racingRepository = {
      ...baseRepository,
      listIdentityClaims: (requestedProjectId?: string) =>
        Effect.gen(function* () {
          const claims = yield* baseRepository.listIdentityClaims(requestedProjectId);
          if (!injected) {
            injected = true;
            git(repositoryPath, "config", GIT_PROJECT_ID_KEY, projectId);
          }
          return claims;
        }),
    };
    const service = await makeManagedStackService({
      repository: racingRepository,
      stateRoot: join(root, "managed"),
      publicationPollMs: 1,
    });
    openHandles.push(service);

    const resolved = await service.resolveStack({
      workspacePath: repositoryPath,
      operation: "start",

      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });

    expect(injected).toBe(true);
    expect(resolved.identity).toMatchObject({
      projectId,
      checkoutId: expect.any(String),
      contextId: expect.any(String),
    });
  });
});

const runRepo = Effect.runSync;

const invalidStackNames = managedStackContractFixtures
  .filter(({ id }) => id.startsWith("identity.invalid-stack-name-"))
  .flatMap((scenario) =>
    scenario.given.flatMap((fact) => (fact.kind === "stack-names" ? fact.names : [])),
  );

/** A running stack, so port reservations and stop paths are actually exercised. */
const running = (): ResolveManagedStackRequest["configuration"] => ({ lifecycle: "running" });
const portDocumentFor = (port: number) => ({
  activeFields: ["apiPort"] as const,
  document: { api: { port } },
});

describe.each(adapters)("resolveStack over git workspaces with the %s adapter", (_name, make) => {
  const openService = async (root: string): Promise<ManagedStackServiceHandle> => {
    const service = await make(root);
    openHandles.push(service);
    return service;
  };

  const startRacingServices = async (root: string, workspacePath: string) => {
    let repositoryA: ManagedStackRepositoryShape;
    let repositoryB: ManagedStackRepositoryShape;
    if (_name === "in-memory") {
      const repository = createInMemoryManagedStackRepository();
      repositoryA = repository;
      repositoryB = repository;
    } else {
      const baseA = await make(root);
      const baseB = await make(root);
      openHandles.push(baseA, baseB);
      repositoryA = baseA.repository;
      repositoryB = baseB.repository;
    }

    let firstReservation = true;
    let notifyReservation: () => void = () => undefined;
    const reservationObserved = new Promise<void>((resolve) => {
      notifyReservation = resolve;
    });
    let releaseReservation: () => void = () => undefined;
    const reservationGate = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });
    const gateReservation = (repository: ManagedStackRepositoryShape) => ({
      ...repository,
      reserveIdentityTransition: (
        input: Parameters<typeof repository.reserveIdentityTransition>[0],
      ) =>
        Effect.gen(function* () {
          const transition = yield* repository.reserveIdentityTransition(input);
          if (firstReservation) {
            firstReservation = false;
            notifyReservation();
            yield* Effect.promise(() => reservationGate);
          }
          return transition;
        }),
    });
    const serviceA = await makeManagedStackService({
      repository: gateReservation(repositoryA),
      stateRoot: join(root, "race-managed-a"),
      publicationPollMs: 1,
    });
    const serviceB = await makeManagedStackService({
      repository: gateReservation(repositoryB),
      stateRoot: join(root, "race-managed-b"),
      publicationPollMs: 1,
    });
    openHandles.push(serviceA, serviceB);

    const firstAttempt = serviceA.resolveStack({
      workspacePath,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    await reservationObserved;
    const secondAttempt = serviceB
      .resolveStack({
        workspacePath,
        operation: "start",
        portDocument: defaultPortDocument,
        initialize: defaultInitialize,
      })
      .finally(() => releaseReservation());
    return { service: serviceA, firstAttempt, secondAttempt };
  };

  it("gives sibling worktrees one project, separate checkouts, and independent stacks", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    git(repository, "worktree", "add", "-q", join(root, "wt-a"), "-b", "feat/a");
    git(repository, "worktree", "add", "-q", join(root, "wt-b"), "-b", "feat/b");
    const service = await openService(root);

    const first = await service.resolveStack({
      workspacePath: join(root, "wt-a"),
      operation: "start",

      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    const second = await service.resolveStack({
      workspacePath: join(root, "wt-b"),
      operation: "start",

      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });

    expect(second.identity.projectId).toBe(first.identity.projectId);
    expect(second.identity.checkoutId).not.toBe(first.identity.checkoutId);
    expect(second.identity.contextId).not.toBe(first.identity.contextId);
    expect(second.stack.id).not.toBe(first.stack.id);
    expect(first.workspace.checkoutKind).toBe("linked-worktree");
    expect(first.context).toEqual({ kind: "branch", branch: "feat/a" });
    expect(first.workspace.projectIdentityLocation).toBe(join(repository, ".git"));
    expect(first.workspace.checkoutIdentityLocation).toBe(
      join(repository, ".git", "worktrees", "wt-a"),
    );

    // Both live rows coexist under the one-live-stack-per-identity index, and a
    // reader can tell them apart without resolving either workspace again.
    const listed = await service.listStacks();
    expect(listed).toHaveLength(2);
    expect(listed.map((stack) => stack.canonicalPath).sort()).toEqual([
      join(root, "wt-a"),
      join(root, "wt-b"),
    ]);
    expect(listed.map((stack) => stack.contextLocator).sort()).toEqual(["feat/a", "feat/b"]);
    expect(new Set(listed.map((stack) => stack.checkoutKind))).toEqual(
      new Set(["linked-worktree"]),
    );
  });

  it("resolves one stack for a checkout however deep in it a start is run", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const nested = makeDirectory(repository, join("apps", "web"));
    const service = await openService(root);

    const fromRoot = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    const fromNested = await service.resolveStack({
      workspacePath: nested,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });

    expect(fromNested.outcome).toBe("reuse");
    expect(fromNested.stack.id).toBe(fromRoot.stack.id);
    expect(fromNested.identity).toEqual(fromRoot.identity);
    // The resolution still reports where the caller actually is...
    expect(fromNested.workspace.canonicalPath).toBe(nested);
    expect(fromNested.workspace.workspaceRoot).toBe(repository);
    // ...while the one location a checkout has stays the checkout's root, which
    // is what lets a start from anywhere inside it resolve the same stack.
    expect(fromNested.stack.canonicalPath).toBe(repository);
    expect(
      runRepo(service.repository.listCheckoutLocations()).map((location) => location.canonicalPath),
    ).toEqual([repository]);
  });

  it("registers the checkout root even when the first start runs from a subdirectory", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const nested = makeDirectory(repository, join("packages", "api"));
    const service = await openService(root);

    const created = await service.resolveStack({
      workspacePath: nested,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });

    expect(created.outcome).toBe("create");
    expect(created.stack.canonicalPath).toBe(repository);
    // A subdirectory recorded as the checkout's location would be permanent, so
    // the checkout's own root must still resolve to the stack it registered.
    const reported = await service.resolveStack({
      workspacePath: repository,
      operation: "status",
      portDocument: defaultPortDocument,
    });
    expect(reported.selection?.stackId).toBe(created.stack.id);
    expect(reported.identity).toEqual(created.identity);
  });

  it("keeps the same branch in two worktrees on one context and two stacks", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    git(repository, "worktree", "add", "-q", "-f", "--checkout", join(root, "wt-main"), "main");
    const service = await openService(root);

    const primary = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    const forced = await service.resolveStack({
      workspacePath: join(root, "wt-main"),
      operation: "start",

      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });

    // Git owns the branch context, so both worktrees resolve the same one...
    expect(forced.identity.contextId).toBe(primary.identity.contextId);
    // ...and the checkout is still part of the stack's identity, so neither
    // worktree can adopt the other's stack.
    expect(forced.identity.checkoutId).not.toBe(primary.identity.checkoutId);
    expect(forced.outcome).toBe("create");
    expect(forced.stack.id).not.toBe(primary.stack.id);
    expect(forced.stack.paths.root).not.toBe(primary.stack.paths.root);
    expect(primary.workspace.checkoutKind).toBe("git");
    expect(forced.workspace.checkoutKind).toBe("linked-worktree");
  });

  it("shares a bare repository's project across its worktrees", async () => {
    const root = makeRoot();
    const bare = makeBareRepository(root, makeRepository(root));
    git(bare, "worktree", "add", "-q", join(root, "bare-a"), "-b", "bare-a", "main");
    git(bare, "worktree", "add", "-q", join(root, "bare-b"), "-b", "bare-b", "main");
    const service = await openService(root);

    const first = await service.resolveStack({
      workspacePath: join(root, "bare-a"),
      operation: "start",

      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    const second = await service.resolveStack({
      workspacePath: join(root, "bare-b"),
      operation: "start",

      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });

    expect(second.identity.projectId).toBe(first.identity.projectId);
    expect(second.identity.checkoutId).not.toBe(first.identity.checkoutId);
    expect(first.workspace.checkoutKind).toBe("bare-worktree");
    // There is no primary worktree to fall back on, so the bare repository
    // directory itself is where the project identity lives.
    expect(first.workspace.projectIdentityLocation).toBe(bare);
    expect(first.workspace.checkoutIdentityLocation).toBe(join(bare, "worktrees", "bare-a"));
    expect(second.workspace.projectIdentityLocation).toBe(bare);
    expect(storedConfigValue(gitConfigPath(bare), GIT_PROJECT_ID_KEY)).toBe(
      first.identity.projectId,
    );
  });

  it("scopes named stacks inside one context without letting them share anything", async () => {
    const fixture = managedStackContractFixtures.find(
      ({ id }) => id === "ports.explicit-port-conflict-with-sibling-fails",
    );
    if (fixture === undefined) throw new Error("Missing exact sibling port fixture");
    expect("error" in fixture.expected ? fixture.expected.error?.code : undefined).toBe(
      "EXACT_PORT_OCCUPIED",
    );
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await openService(root);
    const names = ["default", "review", "review-42"];
    const automaticPortDocument = { activeFields: ["apiPort"] as const, document: {} };

    const resolved = [];
    for (const stackName of names) {
      resolved.push(
        await service.resolveStack({
          workspacePath: repository,
          operation: "start",
          stackName,
          configuration: running(),
          portDocument: automaticPortDocument,
          initialize: defaultInitialize,
        }),
      );
    }

    const [first] = resolved;
    for (const resolution of resolved) {
      expect(resolution.outcome).toBe("create");
      expect(resolution.identity.checkoutId).toBe(first?.identity.checkoutId);
      expect(resolution.identity.contextId).toBe(first?.identity.contextId);
    }
    expect(new Set(resolved.map(({ stack }) => stack.id)).size).toBe(names.length);
    expect(new Set(resolved.map(({ stack }) => stack.paths.root)).size).toBe(names.length);
    expect(
      new Set(resolved.flatMap(({ stack }) => stack.ports.map((port) => port.port))).size,
    ).toBe(names.length);

    const listed = await service.listStacks();
    expect(listed.map((stack) => stack.name).sort()).toEqual([...names].sort());
    expect(new Set(listed.map((stack) => stack.contextKind))).toEqual(new Set(["branch"]));

    // The ports the siblings occupy are reserved registry-wide, so a fourth
    // named stack cannot quietly take one of them.
    const conflictPort = resolved[1]?.stack.ports[0]?.port;
    if (conflictPort === undefined) throw new Error("Named stack did not persist its exact port");
    const conflict = await service
      .resolveStack({
        workspacePath: repository,
        operation: "start",
        stackName: "conflicting",
        configuration: running(),
        portDocument: portDocumentFor(conflictPort),
        initialize: defaultInitialize,
      })
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(ManagedExactPortOccupiedError);
    if (!(conflict instanceof ManagedExactPortOccupiedError)) {
      throw new Error("Expected an exact sibling port conflict");
    }
    expect(conflict.ownerStackId).toBe(resolved[1]?.stack.id);
    expect(conflict.ownerStackName).toBe("review");
  });

  it("refuses an invalid stack name before claiming or registering anything", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const gitDirectory = join(repository, ".git");
    const service = await openService(root);

    for (const stackName of invalidStackNames) {
      await expect(
        service.resolveStack({
          workspacePath: repository,
          operation: "start",
          stackName,
          portDocument: defaultPortDocument,
          initialize: defaultInitialize,
        }),
      ).rejects.toBeInstanceOf(InvalidManagedStackNameError);

      expect(existsSync(gitCheckoutIdentityPath(gitDirectory))).toBe(false);
      expect(storedConfigValue(gitConfigPath(gitDirectory), GIT_PROJECT_ID_KEY)).toBeUndefined();
      expect(
        storedConfigValue(gitConfigPath(gitDirectory), gitBranchContextIdKey("main")),
      ).toBeUndefined();
      expect(await service.listStacks()).toEqual([]);
      expect(runRepo(service.repository.listCheckoutLocations())).toEqual([]);
    }
  });

  it("reports an unregistered checkout without writing anything", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const gitDirectory = join(repository, ".git");
    const service = await openService(root);

    const result = await service.resolveStack({
      workspacePath: repository,
      operation: "status",
      portDocument: defaultPortDocument,
    });

    expect(result.outcome).toBe("report");
    expect(result.state).toBe("unregistered");
    expect(result.identity).toEqual({});
    expect(result.stacks).toEqual([]);
    expect(result.stack).toBeUndefined();
    expect(result.selection).toBeUndefined();
    expect(result.identityMarkerCreated).toBe(false);
    // The classification itself is still complete: a caller can report what the
    // workspace is without any of it having been claimed.
    expect(result.workspace.checkoutKind).toBe("git");
    expect(result.context).toEqual({ kind: "branch", branch: "main" });
    expect(result.workspace.projectIdentityLocation).toBe(gitDirectory);

    expect(existsSync(gitCheckoutIdentityPath(gitDirectory))).toBe(false);
    expect(storedConfigValue(gitConfigPath(gitDirectory), GIT_PROJECT_ID_KEY)).toBeUndefined();
    expect(
      storedConfigValue(gitConfigPath(gitDirectory), gitBranchContextIdKey("main")),
    ).toBeUndefined();
    expect(runRepo(service.repository.listStacks())).toEqual([]);
    expect(runRepo(service.repository.listCheckoutLocations())).toEqual([]);
    expect(existsSync(join(root, "managed", "stacks"))).toBe(false);
  });

  it("reuses one detached context across commits and keeps worktrees apart", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const firstCommit = git(repository, "rev-parse", "HEAD").trim();
    git(repository, "commit", "-q", "--allow-empty", "-m", "second");
    const secondCommit = git(repository, "rev-parse", "HEAD").trim();
    git(repository, "checkout", "-q", firstCommit);
    const service = await openService(root);

    const parked = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    expect(parked.context).toEqual({ kind: "detached", commit: firstCommit });
    expect(parked.stack.contextKind).toBe("detached");
    expect(parked.stack.contextLocator).toBeUndefined();

    // A different commit in the same checkout is the same development context:
    // keying one per commit would strand a stack on every checkout.
    git(repository, "checkout", "-q", secondCommit);
    const moved = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    expect(moved.context.commit).toBe(secondCommit);
    expect(moved.identity.contextId).toBe(parked.identity.contextId);
    expect(moved.outcome).toBe("reuse");
    expect(moved.stack.id).toBe(parked.stack.id);

    // Git records nothing about a detached context, so the read-only path has to
    // find it in the registry — and does.
    const reported = await service.resolveStack({
      workspacePath: repository,
      operation: "status",

      portDocument: defaultPortDocument,
    });
    expect(reported.identity.contextId).toBe(parked.identity.contextId);
    expect(reported.selection?.stackId).toBe(parked.stack.id);

    git(repository, "worktree", "add", "-q", "--detach", join(root, "wt-detached"), secondCommit);
    const sibling = await service.resolveStack({
      workspacePath: join(root, "wt-detached"),
      operation: "start",

      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    expect(sibling.identity.contextId).not.toBe(parked.identity.contextId);
    expect(sibling.stack.id).not.toBe(parked.stack.id);
  });

  it("converges on one detached context when two starts race for it", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    git(repository, "checkout", "-q", git(repository, "rev-parse", "HEAD").trim());
    const { service, firstAttempt, secondAttempt } = await startRacingServices(root, repository);

    // Neither caller can see the other's context before it is committed, so both
    // mint a candidate; the registry keeps the one that landed first, which is
    // what stops a raced detached start from splitting into two stacks.
    const [first, second] = await Promise.all([firstAttempt, secondAttempt]);

    expect(second.identity.contextId).toBe(first.identity.contextId);
    expect(second.stack.id).toBe(first.stack.id);
    expect([first.outcome, second.outcome].sort()).toEqual(["create", "reuse"]);
    expect(await service.listStacks()).toHaveLength(1);
  });

  it("reports exactly one racing start as having published the checkout identity", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const { firstAttempt, secondAttempt } = await startRacingServices(root, repository);

    // Neither caller can see the other's checkout marker before it lands, so
    // both race `ensureGitCheckoutIdentity` on the same unclaimed checkout; the
    // atomic claim settles which one actually published it.
    const [first, second] = await Promise.all([firstAttempt, secondAttempt]);

    expect(second.identity).toEqual(first.identity);
    expect(second.stack.id).toBe(first.stack.id);
    expect([first.identityMarkerCreated, second.identityMarkerCreated].filter(Boolean)).toEqual([
      true,
    ]);
  });

  it("reuses a branch's stack when the branch comes back, renamed or not", async () => {
    const stickyFixture = managedStackContractFixtures.find(
      ({ id }) => id === "ports.sticky-ports-reuse-on-return",
    );
    if (stickyFixture === undefined) throw new Error("Missing sticky port fixture");
    expect(stickyFixture.expected.outcome).toBe("reuse");
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await openService(root);
    const automaticPortDocument = {
      activeFields: ["apiPort", "dbPort"] as const,
      document: {},
    };

    git(repository, "checkout", "-q", "-b", "feat/x");
    const feature = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: automaticPortDocument,
      initialize: defaultInitialize,
    });
    expect(feature.stack.ports).toHaveLength(2);
    expect(feature.stack.ports.every((assignment) => assignment.intent === "automatic")).toBe(true);
    const featurePorts = feature.stack.ports;
    await service.updateStack(feature.stack.id, { lifecycle: "stopped" });
    git(repository, "checkout", "-q", "main");
    const main = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: automaticPortDocument,
      initialize: defaultInitialize,
    });
    expect(main.stack.id).not.toBe(feature.stack.id);
    expect(
      main.stack.ports.every((assignment) =>
        featurePorts.every((featureAssignment) => featureAssignment.port !== assignment.port),
      ),
    ).toBe(true);

    git(repository, "checkout", "-q", "feat/x");
    const returned = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: automaticPortDocument,
      initialize: defaultInitialize,
    });
    expect(returned.outcome).toBe("reuse");
    expect(returned.stack.id).toBe(feature.stack.id);
    expect(returned.stack.ports).toEqual(featurePorts);

    // A rename is git's own operation on the context it owns, so the stack
    // survives it and only the name it is displayed under is refreshed.
    git(repository, "branch", "-m", "feat/x", "feat/renamed");
    const renamed = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: automaticPortDocument,
      initialize: defaultInitialize,
    });
    expect(renamed.outcome).toBe("reuse");
    expect(renamed.stack.id).toBe(feature.stack.id);
    expect(renamed.identity.contextId).toBe(feature.identity.contextId);
    expect(renamed.context).toEqual({ kind: "branch", branch: "feat/renamed" });
    // Running reuse is intentionally read-only: the discovery projection sees
    // the renamed branch, while the durable stack locator is unchanged until a
    // mutating lifecycle operation.
    expect(renamed.stack.contextLocator).toBe("feat/x");

    // The repository query itself must retain the branch context predicate: the
    // main branch shares this project and checkout, but its stack is not part of
    // the renamed branch's projection.
    const branchStacks = runRepo(
      service.repository.listStackProjections({
        identity: {
          projectId: feature.identity.projectId,
          checkoutId: feature.identity.checkoutId,
          contextId: feature.identity.contextId,
        },
      }),
    );
    expect(branchStacks.map((stack) => stack.id)).toEqual([feature.stack.id]);
  });

  it("settles a moved checkout and renamed branch in one subsequent start", async () => {
    const root = makeRoot();
    const original = makeRepository(root, "original");
    const moved = join(root, "moved");
    const service = await openService(root);
    const first = await service.resolveStack({
      workspacePath: original,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });

    git(original, "branch", "-m", "main", "renamed");
    renameSync(original, moved);

    const recovered = await service.resolveStack({
      workspacePath: moved,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    expect(recovered.outcome).toBe("reuse");
    expect(recovered.stack.id).toBe(first.stack.id);
    expect(recovered.identity).toEqual(first.identity);
    expect(recovered.context).toEqual({ kind: "branch", branch: "renamed" });
  });

  it("reports drift for a moved running checkout before automatic rebind", async () => {
    const root = makeRoot();
    const original = makeRepository(root, "original-running");
    const moved = join(root, "moved-running");
    const service = await openService(root);
    const first = await service.resolveStack({
      workspacePath: original,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    renameSync(original, moved);

    const snapshot = async () => ({
      stacks: runRepo(service.repository.listStacks({ includeTombstoned: true })),
      claims: runRepo(service.repository.listIdentityClaims()),
      locations: runRepo(service.repository.listCheckoutLocations()),
      operations: runRepo(service.repository.listActiveOperations()),
      projectId: storedConfigValue(gitConfigPath(join(moved, ".git")), GIT_PROJECT_ID_KEY),
      branchContext: storedConfigValue(
        gitConfigPath(join(moved, ".git")),
        gitBranchContextIdKey("main"),
      ),
    });
    const before = await snapshot();
    let initialized = 0;
    const resolved = await service.resolveStack({
      workspacePath: moved,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: async () => {
        initialized += 1;
        return defaultInitialize();
      },
    });

    expect(resolved.outcome).toBe("reuse");
    expect(resolved.stack.id).toBe(first.stack.id);
    expect(initialized).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(existsSync(original)).toBe(false);
    expect(existsSync(moved)).toBe(true);
  });

  it("settles an active recovery transition before reusing a running stack", async () => {
    const root = makeRoot();
    const previous = makeRepository(root, "transition-owner");
    const moved = join(root, "transition-moved");
    const service = await openService(root);
    const owner = await service.resolveStack({
      workspacePath: previous,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    renameSync(previous, moved);
    const transition = await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: crypto.randomUUID(),
        kind: "rebind-checkout",
        checkoutId: owner.identity.checkoutId,
        projectId: owner.identity.projectId,
        path: moved,
        now: new Date().toISOString(),
      }),
    );
    expect(transition.phase).toBe("reserved");
    expect((await service.discoverWorkspace(moved)).state).toBe("transitioning");

    let initialized = 0;
    const resolved = await service.resolveStack({
      workspacePath: moved,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: async () => {
        initialized += 1;
        return defaultInitialize();
      },
    });

    expect(resolved.outcome).toBe("reuse");
    expect(resolved.stack.id).toBe(owner.stack.id);
    expect(initialized).toBe(0);
    expect((await service.discoverWorkspace(moved)).activeTransition).toBeUndefined();
  });

  it("reports a copied-branch running stack before branch repair", async () => {
    const root = makeRoot();
    const repository = makeRepository(root, "copied-running");
    const service = await openService(root);
    const owner = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    git(repository, "branch", "-c", "main", "copied-running");
    git(repository, "checkout", "-q", "copied-running");
    const snapshot = async () => ({
      stacks: runRepo(service.repository.listStacks({ includeTombstoned: true })),
      claims: runRepo(service.repository.listIdentityClaims()),
      locations: runRepo(service.repository.listCheckoutLocations()),
      operations: runRepo(service.repository.listActiveOperations()),
      copiedContext: storedConfigValue(
        gitConfigPath(join(repository, ".git")),
        gitBranchContextIdKey("copied-running"),
      ),
    });
    const before = await snapshot();
    let initialized = 0;
    const resolved = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: async () => {
        initialized += 1;
        return defaultInitialize();
      },
    });

    expect(resolved.outcome).toBe("reuse");
    expect(resolved.stack.id).toBe(owner.stack.id);
    expect(initialized).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it("reports an adoptable running context before branch adoption", async () => {
    const root = makeRoot();
    const repository = makeRepository(root, "adoptable-running");
    const service = await openService(root);
    git(repository, "checkout", "-q", "-b", "original-running");
    const owner = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    git(repository, "checkout", "-q", "main");
    git(repository, "branch", "-D", "original-running");
    git(repository, "checkout", "-q", "-b", "renamed-running");
    git(repository, "config", gitBranchContextIdKey("renamed-running"), owner.identity.contextId);
    expect((await service.discoverWorkspace(repository)).state).toBe("adoptable");
    const snapshot = async () => ({
      stacks: runRepo(service.repository.listStacks({ includeTombstoned: true })),
      claims: runRepo(service.repository.listIdentityClaims()),
      locations: runRepo(service.repository.listCheckoutLocations()),
      operations: runRepo(service.repository.listActiveOperations()),
      renamedContext: storedConfigValue(
        gitConfigPath(join(repository, ".git")),
        gitBranchContextIdKey("renamed-running"),
      ),
    });
    const before = await snapshot();
    let initialized = 0;
    const resolved = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: async () => {
        initialized += 1;
        return defaultInitialize();
      },
    });

    expect(resolved.outcome).toBe("reuse");
    expect(resolved.stack.id).toBe(owner.stack.id);
    expect(initialized).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it("repairs a copied branch on its first mutating start without changing the owner", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await openService(root);

    const owner = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    git(repository, "branch", "-c", "main", "copied");
    git(repository, "checkout", "-q", "copied");

    const conflict = await service.discoverWorkspace(repository);
    expect(conflict.state).toBe("duplicate");
    expect(conflict.ownerEvidence?.authoritativeOwnerBranch).toBe("main");
    expect(conflict.recoveryOperations).toEqual([]);

    const copied = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    expect(copied.outcome).toBe("create");
    expect(copied.identity.projectId).toBe(owner.identity.projectId);
    expect(copied.identity.checkoutId).toBe(owner.identity.checkoutId);
    expect(copied.identity.contextId).not.toBe(owner.identity.contextId);
    expect(copied.stack.id).not.toBe(owner.stack.id);

    git(repository, "checkout", "-q", "main");
    const ownerAgain = await service.resolveStack({
      workspacePath: repository,
      operation: "start",

      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    expect(ownerAgain.identity.contextId).toBe(owner.identity.contextId);
    expect(ownerAgain.stack.id).toBe(owner.stack.id);
    expect(
      storedConfigValue(gitConfigPath(join(repository, ".git")), gitBranchContextIdKey("copied")),
    ).toBe(copied.identity.contextId);
  });

  it("repairs a copied branch after its checkout was safely rebound", async () => {
    const root = makeRoot();
    const original = makeRepository(root, "original");
    const moved = join(root, "moved");
    const service = await openService(root);
    const owner = await service.resolveStack({
      workspacePath: original,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    renameSync(original, moved);
    const rebound = await service.resolveStack({
      workspacePath: moved,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    expect(rebound.identity).toEqual(owner.identity);

    const reboundReport = await service.discoverWorkspace(moved);
    expect(reboundReport.state).toBe("healthy");
    expect(reboundReport.historicalPathEvidence).toContainEqual({
      path: original,
      locationState: "superseded",
      probe: "missing",
    });
    git(moved, "branch", "-c", "main", "feature");
    git(moved, "checkout", "-q", "feature");

    const feature = await service.resolveStack({
      workspacePath: moved,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    expect(feature.outcome).toBe("create");
    expect(feature.identity.projectId).toBe(owner.identity.projectId);
    expect(feature.identity.checkoutId).toBe(owner.identity.checkoutId);
    expect(feature.identity.contextId).not.toBe(owner.identity.contextId);
    const healthy = await service.discoverWorkspace(moved);
    expect(healthy.state).toBe("healthy");
    expect(healthy.historicalPathEvidence).toContainEqual({
      path: original,
      locationState: "superseded",
      probe: "missing",
    });
    const claims = await Effect.runPromise(service.repository.listIdentityClaims());
    expect(claims.locations).toContainEqual(
      expect.objectContaining({
        checkoutId: owner.identity.checkoutId,
        canonicalPath: original,
        state: "superseded",
      }),
    );
  });

  it("refuses copied-directory branch repair before moving the live checkout", async () => {
    const root = makeRoot();
    const repository = makeRepository(root, "owner");
    const copiedRepository = join(root, "copied");
    const service = await openService(root);
    const owner = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    cpSync(repository, copiedRepository, { recursive: true });
    git(copiedRepository, "branch", "-c", "main", "feature");
    git(copiedRepository, "checkout", "-q", "feature");
    const copiedConfig = gitConfigPath(join(copiedRepository, ".git"));
    const copiedMarker = gitCheckoutIdentityPath(join(copiedRepository, ".git"));
    const beforeConfig = readFileSync(copiedConfig, "utf8");
    const beforeMarker = readFileSync(copiedMarker, "utf8");
    const beforeStatus = git(copiedRepository, "status", "--porcelain");
    const beforeClaims = await Effect.runPromise(service.repository.listIdentityClaims());
    const beforeStacks = await Effect.runPromise(service.repository.listStacks());
    const beforeOperations = await Effect.runPromise(service.repository.listActiveOperations());

    const report = await service.discoverWorkspace(copiedRepository);
    expect(report.state).toBe("duplicate");
    expect(report.recoveryOperations).toEqual([]);
    await expect(
      service.resolveStack({
        workspacePath: copiedRepository,
        operation: "start",
        portDocument: defaultPortDocument,
        initialize: defaultInitialize,
      }),
    ).rejects.toMatchObject({ _tag: "ManagedCheckoutConflictError" });

    expect(readFileSync(copiedConfig, "utf8")).toBe(beforeConfig);
    expect(readFileSync(copiedMarker, "utf8")).toBe(beforeMarker);
    expect(git(copiedRepository, "status", "--porcelain")).toBe(beforeStatus);
    expect(await Effect.runPromise(service.repository.listIdentityClaims())).toEqual(beforeClaims);
    expect(await Effect.runPromise(service.repository.listStacks())).toEqual(beforeStacks);
    expect(await Effect.runPromise(service.repository.listActiveOperations())).toEqual(
      beforeOperations,
    );
    expect(
      beforeClaims.locations.find(
        (location) =>
          location.checkoutId === owner.identity.checkoutId && location.state === "active",
      )?.canonicalPath,
    ).toBe(repository);
    expect((await service.discoverWorkspace(copiedRepository)).state).toBe("duplicate");
  });

  it("resumes a copied branch after Git won but transition advancement failed", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const base = await openService(root);
    const owner = await base.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    git(repository, "branch", "-c", "main", "copy-after-advance-failure");
    git(repository, "checkout", "-q", "copy-after-advance-failure");
    let failAfterGitWrite = true;
    const racingRepository = {
      ...base.repository,
      advanceIdentityTransition: (
        input: Parameters<typeof base.repository.advanceIdentityTransition>[0],
      ) =>
        Effect.gen(function* () {
          if (failAfterGitWrite) {
            failAfterGitWrite = false;
            return yield* Effect.fail(
              new ManagedIdentityTransitionOwnershipError({ transitionId: input.id }),
            );
          }
          return yield* base.repository.advanceIdentityTransition(input);
        }),
    };
    const racing = await makeManagedStackService({
      repository: racingRepository,
      stateRoot: join(root, "racing-managed"),
      publicationPollMs: 1,
    });
    openHandles.push(racing);

    await expect(
      racing.resolveStack({
        workspacePath: repository,
        operation: "start",
        portDocument: defaultPortDocument,
        initialize: defaultInitialize,
      }),
    ).rejects.toMatchObject({ _tag: "ManagedIdentityTransitionOwnershipError" });
    const resumed = await racing.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    expect(resumed.outcome).toBe("create");
    expect(resumed.identity.contextId).not.toBe(owner.identity.contextId);
    expect(
      storedConfigValue(
        gitConfigPath(join(repository, ".git")),
        gitBranchContextIdKey("copy-after-advance-failure"),
      ),
    ).toBe(resumed.identity.contextId);
  });

  it("takes over a copied-branch transition when its original linked worktree disappears", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const linked = join(root, "copy-original");
    const replacement = join(root, "copy-replacement");
    const service = await openService(root);
    const owner = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    git(repository, "worktree", "add", "-q", linked, "-b", "linked");
    git(repository, "config", "branch.linked.supabaseContextId", owner.identity.contextId);
    const linkedCheckoutId = "00000000-0000-7000-8000-000000000401";
    writeFileSync(
      gitCheckoutIdentityPath(git(linked, "rev-parse", "--git-dir").trim()),
      `${JSON.stringify({ version: 1, checkoutId: linkedCheckoutId })}\n`,
    );
    await Effect.runPromise(
      service.repository.registerCheckoutIdentity({
        identity: {
          projectId: owner.identity.projectId,
          checkoutId: linkedCheckoutId,
          contextId: owner.identity.contextId,
        },
        checkoutKind: "linked-worktree",
        checkoutRootPath: linked,
        locationId: "00000000-0000-7000-8000-000000000402",
        context: { kind: "branch", locator: "linked" },
        now: new Date().toISOString(),
      }),
    );

    let interruptAdvance = true;
    const interruptedRepository: ManagedStackRepositoryShape = {
      ...service.repository,
      advanceIdentityTransition: (input) =>
        interruptAdvance
          ? ((interruptAdvance = false),
            Effect.fail(new ManagedIdentityTransitionOwnershipError({ transitionId: input.id })))
          : service.repository.advanceIdentityTransition(input),
    };
    const recovering = await makeManagedStackService({
      repository: interruptedRepository,
      stateRoot: join(root, "copy-takeover-managed"),
      publicationPollMs: 1,
    });
    openHandles.push(recovering);

    await expect(
      recovering.resolveStack({
        workspacePath: linked,
        operation: "start",
        portDocument: defaultPortDocument,
        initialize: defaultInitialize,
      }),
    ).rejects.toMatchObject({ _tag: "ManagedIdentityTransitionOwnershipError" });
    const interrupted = await Effect.runPromise(
      service.repository.listIdentityClaims(owner.identity.projectId),
    );
    const transition = interrupted.transitions.find(
      (candidate) => candidate.kind === "branch-copy",
    );
    expect(transition).toMatchObject({
      phase: "reserved",
      path: linked,
      projectId: owner.identity.projectId,
      checkoutId: linkedCheckoutId,
      contextId: owner.identity.contextId,
      branch: "linked",
    });
    expect(transition?.targetGitValue).toEqual(expect.any(String));

    rmSync(linked, { recursive: true, force: true });
    git(repository, "worktree", "prune");
    git(repository, "worktree", "add", "-q", replacement, "linked");

    const resolved = await recovering.resolveStack({
      workspacePath: replacement,
      operation: "start",

      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    expect(resolved.outcome).toBe("create");
    expect(resolved.identity.projectId).toBe(owner.identity.projectId);
    expect(resolved.identity.checkoutId).not.toBe(linkedCheckoutId);
    expect(resolved.identity.contextId).toBe(transition?.targetGitValue);
    expect((await service.discoverWorkspace(replacement)).state).toBe("healthy");
    expect(
      (await Effect.runPromise(service.repository.listIdentityClaims())).transitions.filter(
        (candidate) => candidate.phase !== "finalized",
      ),
    ).toEqual([]);
  });

  it("does not overwrite a competing branch owner discovered during registration", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const base = await openService(root);
    const first = await base.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    let raced = false;
    const racingRepository = {
      ...base.repository,
      prepareStack: (input: Parameters<typeof base.repository.prepareStack>[0]) =>
        Effect.gen(function* () {
          const prepared = yield* base.repository.prepareStack(input);
          if (!raced) {
            raced = true;
            yield* base.repository.refreshContextOwner({
              contextId: first.identity.contextId,
              ownerBranch: "competing-owner",
              locator: "competing-owner",
              now: new Date().toISOString(),
            });
          }
          return prepared;
        }),
    };
    const racing = await makeManagedStackService({
      repository: racingRepository,
      stateRoot: join(root, "owner-race-managed"),
      publicationPollMs: 1,
    });
    openHandles.push(racing);
    await racing.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    const claims = await Effect.runPromise(
      base.repository.listIdentityClaims(first.identity.projectId),
    );
    expect(
      claims.contexts.find((context) => context.id === first.identity.contextId)?.ownerBranch,
    ).toBe("competing-owner");
  });

  it("refuses a copied-branch transition with a missing target without changing the branch key", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await openService(root);
    const owner = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    git(repository, "branch", "-c", "main", "copy");
    git(repository, "checkout", "-q", "copy");
    await Effect.runPromise(
      service.repository.reserveIdentityTransition({
        id: "00000000-0000-7000-8000-000000000099",
        kind: "branch-copy",
        projectId: owner.identity.projectId,
        checkoutId: owner.identity.checkoutId,
        contextId: owner.identity.contextId,
        branch: "copy",
        path: repository,
        expectedGitValue: owner.identity.contextId,
        now: new Date().toISOString(),
      }),
    );
    const before = storedConfigValue(
      gitConfigPath(join(repository, ".git")),
      gitBranchContextIdKey("copy"),
    );
    await expect(
      service.resolveStack({
        workspacePath: repository,
        operation: "start",
        portDocument: defaultPortDocument,
        initialize: defaultInitialize,
      }),
    ).rejects.toMatchObject({ _tag: "ManagedIdentityTransitionOwnershipError" });
    expect(
      storedConfigValue(gitConfigPath(join(repository, ".git")), gitBranchContextIdKey("copy")),
    ).toBe(before);
  });

  it("adopts an unambiguous renamed branch context through the explicit recovery operation", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await openService(root);

    git(repository, "checkout", "-q", "-b", "original");
    const original = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    git(repository, "checkout", "-q", "main");
    git(repository, "branch", "-D", "original");
    git(repository, "checkout", "-q", "-b", "renamed");
    git(repository, "config", gitBranchContextIdKey("renamed"), original.identity.contextId);

    const report = await service.discoverWorkspace(repository);
    expect(report.state).toBe("adoptable");
    expect(report.recoveryOperations).toContainEqual({
      operation: "adoptContext",
      contextId: original.identity.contextId,
      branch: "renamed",
    });
    const adopted = await service.adoptContext({ workspacePath: repository, observation: report });
    expect(adopted.state).toBe("healthy");
    expect(adopted.ownerEvidence?.authoritativeOwnerBranch).toBe("renamed");

    const reused = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    expect(reused.outcome).toBe("reuse");
    expect(reused.identity.contextId).toBe(original.identity.contextId);
    expect(reused.stack.id).toBe(original.stack.id);
  });

  it("preserves a branch context across ref movement and mints a new one after delete/recreate", async () => {
    const root = makeRoot();
    const repository = makeRepository(root);
    const service = await openService(root);

    git(repository, "checkout", "-q", "-b", "lifecycle");
    const first = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    const firstCommit = git(repository, "rev-parse", "HEAD").trim();
    git(repository, "commit", "-q", "--allow-empty", "-m", "move");
    git(repository, "reset", "-q", "--hard", firstCommit);
    git(repository, "update-ref", "refs/heads/lifecycle", firstCommit);
    const moved = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    expect(moved.identity.contextId).toBe(first.identity.contextId);
    expect(moved.stack.id).toBe(first.stack.id);

    git(repository, "checkout", "-q", "main");
    git(repository, "branch", "-D", "lifecycle");
    git(repository, "checkout", "-q", "-b", "lifecycle");
    const recreated = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    expect(recreated.identity.contextId).not.toBe(first.identity.contextId);
    expect(recreated.stack.id).not.toBe(first.stack.id);
  });

  it("resolves an ordinary folder through the same path as a checkout", async () => {
    const root = makeRoot();
    const workspace = makeDirectory(root, "workspace");
    const service = await openService(root);

    const created = await service.resolveStack({
      workspacePath: workspace,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });

    expect(created.outcome).toBe("create");
    expect(created.identityMarkerCreated).toBe(true);
    expect(created.workspace.checkoutKind).toBe("ordinary");
    expect(created.workspace.workspaceRoot).toBe(workspace);
    expect(created.context).toEqual({ kind: "workspace" });
    expect(created.stack.contextKind).toBe("workspace");
    expect(created.stack.canonicalPath).toBe(workspace);

    const reused = await service.resolveStack({
      workspacePath: workspace,
      operation: "start",
      portDocument: defaultPortDocument,
      initialize: defaultInitialize,
    });
    expect(reused.outcome).toBe("reuse");
    expect(reused.identityMarkerCreated).toBe(false);
    expect(reused.stack.id).toBe(created.stack.id);
  });
});

describe.each(adapters)("managed stack isolation with the %s adapter", (_name, make) => {
  const openService = async (root: string): Promise<ManagedStackServiceHandle> => {
    const service = await make(root);
    openHandles.push(service);
    return service;
  };

  /**
   * Three stacks that are as close to each other as the model allows: two
   * sibling worktrees of one repository, plus a second named stack inside the
   * first worktree's context.
   */
  const startSiblings = async (root: string, service: ManagedStackServiceHandle) => {
    const repository = makeRepository(root);
    git(repository, "worktree", "add", "-q", join(root, "wt-b"), "-b", "feat/b");
    const automaticPortDocument = { activeFields: ["apiPort"] as const, document: {} };
    const primary = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      configuration: running(),
      portDocument: automaticPortDocument,
      initialize: defaultInitialize,
    });
    const named = await service.resolveStack({
      workspacePath: repository,
      operation: "start",
      stackName: "review",
      configuration: running(),
      portDocument: automaticPortDocument,
      initialize: defaultInitialize,
    });
    const worktree = await service.resolveStack({
      workspacePath: join(root, "wt-b"),
      operation: "start",
      configuration: running(),
      portDocument: automaticPortDocument,
      initialize: defaultInitialize,
    });
    return { repository, primary, named, worktree };
  };

  it("leaves sibling stacks untouched when one is deleted, and repeats as a no-op", async () => {
    const root = makeRoot();
    const service = await openService(root);
    const { repository, primary, named, worktree } = await startSiblings(root, service);

    const deleted = await service.deleteStack(primary.stack.id, { stop: () => Promise.resolve() });

    expect(deleted.outcome).toBe("delete");
    expect(deleted.dataReclamation).toEqual({ outcome: "removed" });
    expect(existsSync(primary.stack.paths.root)).toBe(false);

    for (const survivor of [named, worktree]) {
      const record = await service.inspectStack(survivor.stack.id);
      expect(record?.lifecycle).toBe("running");
      expect(record?.ports).toEqual(survivor.stack.ports);
      expect(existsSync(survivor.stack.paths.data)).toBe(true);
    }
    // Deleting a stack is not deregistering a workspace: the identities the
    // surviving siblings resolve through are still exactly where they were.
    expect(existsSync(gitCheckoutIdentityPath(join(repository, ".git")))).toBe(true);
    expect(storedConfigValue(gitConfigPath(join(repository, ".git")), GIT_PROJECT_ID_KEY)).toBe(
      primary.identity.projectId,
    );
    const remaining = await service.resolveStack({
      workspacePath: repository,
      operation: "status",

      portDocument: defaultPortDocument,
    });
    expect(remaining.state).toBe("unregistered");
    expect(remaining.stacks.map((stack) => stack.id)).toEqual([named.stack.id]);

    const repeated = await service.deleteStack(primary.stack.id);
    expect(repeated.outcome).toBe("no-op");
    expect((await service.listStacks()).map((stack) => stack.id).sort()).toEqual(
      [named.stack.id, worktree.stack.id].sort(),
    );
  });

  it("stops one sibling without disturbing the others", async () => {
    const root = makeRoot();
    const service = await openService(root);
    const { named, primary, worktree } = await startSiblings(root, service);

    const stopped = await service.updateStack(worktree.stack.id, {
      lifecycle: "stopped",
      runtimeMetadata: { processIds: {}, containerIds: {} },
    });

    expect(stopped.lifecycle).toBe("stopped");
    for (const survivor of [primary, named]) {
      const record = await service.inspectStack(survivor.stack.id);
      expect(record?.lifecycle).toBe("running");
      expect(record?.ports).toEqual(survivor.stack.ports);
      expect(existsSync(survivor.stack.paths.data)).toBe(true);
    }
  });

  it("deletes an orphaned worktree's stack by its opaque id", async () => {
    const root = makeRoot();
    const service = await openService(root);
    const { worktree, named, primary } = await startSiblings(root, service);

    // The workspace is gone, so nothing can resolve this stack any more — only
    // its opaque id can reach it, which is exactly what deletion takes.
    rmSync(join(root, "wt-b"), { force: true, recursive: true });

    const deleted = await service.deleteStack(worktree.stack.id, {
      stop: () => Promise.resolve(),
    });
    expect(deleted.outcome).toBe("delete");
    expect(existsSync(worktree.stack.paths.root)).toBe(false);
    expect((await service.deleteStack(worktree.stack.id)).outcome).toBe("no-op");
    for (const survivor of [primary, named]) {
      expect((await service.inspectStack(survivor.stack.id))?.lifecycle).toBe("running");
    }
  });
});
