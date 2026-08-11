import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { managedStackContractFixtures } from "./managed-stack-contract.ts";
import { ordinaryWorkspaceIdentityPath } from "./managed/paths.ts";
import {
  InvalidManagedIdentityError,
  ManagedPortReservationError,
  ManagedStackInitializationError,
  UnsupportedManagedRegistryVersionError,
} from "./managed/model.ts";
import { createInMemoryManagedStackRepository } from "./managed/repository.ts";
import { makeManagedStackService, type ManagedStackService } from "./managed/service.ts";
import { openBunSqliteManagedStackRepository } from "./managed/sqlite-bun.ts";

const temporaryRoots: Array<string> = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "managed-stack-test-"));
  temporaryRoots.push(root);
  return root;
};

const makeWorkspace = (root: string, name = "workspace"): string => {
  const workspace = join(root, name);
  mkdirSync(workspace, { recursive: true });
  return workspace;
};

const makeInMemoryService = (root: string): ManagedStackService =>
  makeManagedStackService({
    repository: createInMemoryManagedStackRepository(),
    stateRoot: join(root, "managed"),
    publicationPollMs: 1,
  });

const makePersistentService = (root: string): ManagedStackService => {
  const stateRoot = join(root, "managed");
  return makeManagedStackService({
    repository: openBunSqliteManagedStackRepository(join(stateRoot, "registry-v1.sqlite3")),
    stateRoot,
    publicationPollMs: 1,
  });
};

const fixture = (id: string) => {
  const scenario = managedStackContractFixtures.find((candidate) => candidate.id === id);
  if (scenario === undefined) {
    throw new Error(`Missing managed stack contract fixture ${id}`);
  }
  return scenario;
};

describe("ordinary-folder managed stack contract", () => {
  it("keeps read-only discovery registration-free", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = makeInMemoryService(root);

    const result = await service.inspectOrdinaryWorkspace(workspace);

    expect(result).toEqual({ registered: false, stacks: [] });
    expect(existsSync(ordinaryWorkspaceIdentityPath(workspace))).toBe(false);
    expect(service.repository.listStacks()).toEqual([]);
    expect(service.repository.listCheckoutLocations()).toEqual([]);
  });

  it("fails safely on an unknown newer workspace identity marker", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = makeInMemoryService(root);
    const markerPath = ordinaryWorkspaceIdentityPath(workspace);
    mkdirSync(join(workspace, ".supabase"));
    writeFileSync(
      markerPath,
      JSON.stringify({
        version: 999,
        projectId: crypto.randomUUID(),
        checkoutId: crypto.randomUUID(),
        contextId: crypto.randomUUID(),
      }),
    );

    await expect(
      service.provisionOrdinaryStack({ workspacePath: workspace }),
    ).rejects.toBeInstanceOf(InvalidManagedIdentityError);
    expect(service.repository.listStacks()).toEqual([]);
    expect(service.repository.listCheckoutLocations()).toEqual([]);
  });

  it("executes the first-start and persisted-identity M1 fixtures against SQLite", async () => {
    const firstStart = fixture("identity.non-git-folder-first-start-persists-identity");
    const recoveredStart = fixture("identity.non-git-folder-recovers-persisted-identity");
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = makePersistentService(root);

    const created = await service.provisionOrdinaryStack({
      workspacePath: workspace,
      configuration: {
        runtimeRequest: "docker",
        runtime: "docker",
        ports: [{ key: "api.port", port: 54_321, intent: "automatic" }],
        serviceVersions: { postgres: "17.6.1" },
        runtimeMetadata: {
          pid: process.pid,
          socketPath: join(root, "daemon.sock"),
          processIds: { postgres: process.pid },
          containerIds: { auth: "container-auth" },
        },
        configFingerprint: "config-v1",
        credentialsReference: "credentials-v1",
      },
    });

    expect(created.outcome).toBe(firstStart.expected.outcome);
    expect(created.identityMarkerCreated).toBe(true);
    expect(created.stack.status).toBe("active");
    expect(created.stack.paths.root).toBe(join(service.stateRoot, "stacks", created.stack.id));
    expect(created.stack.paths.root.startsWith(workspace)).toBe(false);
    expect(created.stack.ports).toEqual([{ key: "api.port", port: 54_321, intent: "automatic" }]);
    expect(created.stack.serviceVersions).toEqual({ postgres: "17.6.1" });
    expect(created.stack.runtimeMetadata).toEqual({
      pid: process.pid,
      socketPath: join(root, "daemon.sock"),
      processIds: { postgres: process.pid },
      containerIds: { auth: "container-auth" },
    });
    expect(existsSync(created.stack.paths.data)).toBe(true);
    expect(existsSync(created.stack.paths.logs)).toBe(true);
    expect(existsSync(created.stack.paths.runtime)).toBe(true);

    const marker = JSON.parse(readFileSync(ordinaryWorkspaceIdentityPath(workspace), "utf8"));
    expect(Object.keys(marker).sort()).toEqual(["checkoutId", "contextId", "projectId", "version"]);
    expect(marker).toMatchObject({
      projectId: created.selection.projectId,
      checkoutId: created.selection.checkoutId,
      contextId: created.selection.contextId,
    });

    service.close();
    const reopened = makePersistentService(root);
    const reused = await reopened.provisionOrdinaryStack({ workspacePath: workspace });

    expect(reused.outcome).toBe(recoveredStart.expected.outcome);
    expect(reused.identityMarkerCreated).toBe(false);
    expect(reused.selection).toEqual(created.selection);
    expect(reused.stack.ports).toEqual(created.stack.ports);
    expect(reopened.listStacks()).toHaveLength(1);
    reopened.close();

    const registry = new Database(join(root, "managed", "registry-v1.sqlite3"));
    const columns = registry.query("PRAGMA table_info(stacks)").all();
    const columnNames = columns.map((column) =>
      typeof column === "object" && column !== null ? Reflect.get(column, "name") : undefined,
    );
    expect(columnNames).not.toContain("credentials");
    expect(columnNames).not.toContain("secret_key");
    expect(columnNames).toContain("credentials_reference");
    registry.close();
  });

  it("accepts an injected repository and isolated state root without CLI ownership", async () => {
    const contract = fixture("api-boundary.managed-api-accepts-injected-repository");
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const repository = createInMemoryManagedStackRepository();
    const stateRoot = join(root, "isolated-managed-state");
    const service = makeManagedStackService({ repository, stateRoot });

    const result = await service.provisionOrdinaryStack({ workspacePath: workspace });

    expect(contract.expected.outcome).toBe("create");
    expect(result.outcome).toBe("create");
    expect(service.repository).toBe(repository);
    expect(result.stack.paths.root.startsWith(stateRoot)).toBe(true);
  });

  it("publishes one stack when two callers provision the same identity concurrently", async () => {
    const contract = fixture("identity.concurrent-create-publishes-once");
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = makePersistentService(root);
    let releaseInitialization: () => void = () => {};
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    let initializerCalls = 0;

    const first = service.provisionOrdinaryStack({
      workspacePath: workspace,
      initialize: async () => {
        initializerCalls += 1;
        await initializationGate;
      },
    });
    while (service.repository.listStacks().length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const second = service.provisionOrdinaryStack({ workspacePath: workspace });
    releaseInitialization();
    const results = await Promise.all([first, second]);

    expect(contract.expected.outcome).toBe("create");
    expect(results.map((result) => result.outcome).sort()).toEqual(["create", "reuse"]);
    expect(new Set(results.map((result) => result.stack.id))).toHaveProperty("size", 1);
    expect(initializerCalls).toBe(1);
    expect(service.repository.listStacks()).toHaveLength(1);
    service.close();
  });

  it("rolls back failed initialization and makes the same start retryable", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = makePersistentService(root);
    let failedRoot: string | undefined;

    await expect(
      service.provisionOrdinaryStack({
        workspacePath: workspace,
        initialize: async (stack) => {
          failedRoot = stack.paths.root;
          throw new Error("initialization failed");
        },
      }),
    ).rejects.toBeInstanceOf(ManagedStackInitializationError);

    expect(failedRoot).toBeDefined();
    expect(existsSync(failedRoot ?? "")).toBe(false);
    expect(service.listStacks()).toEqual([]);
    expect(existsSync(ordinaryWorkspaceIdentityPath(workspace))).toBe(true);

    const retried = await service.provisionOrdinaryStack({ workspacePath: workspace });
    expect(retried.outcome).toBe("create");
    expect(service.listStacks()).toHaveLength(1);
    service.close();
  });
});

describe("managed repository and lifecycle", () => {
  for (const adapter of ["in-memory", "sqlite"] as const) {
    it(`keeps repository decisions storage-agnostic for the ${adapter} adapter`, async () => {
      const contract = fixture("api-boundary.repository-contract-is-storage-agnostic");
      const root = makeRoot();
      const workspace = makeWorkspace(root);
      const service =
        adapter === "in-memory" ? makeInMemoryService(root) : makePersistentService(root);

      const created = await service.provisionOrdinaryStack({ workspacePath: workspace });
      const reused = await service.provisionOrdinaryStack({ workspacePath: workspace });

      expect(contract.expected.outcome).toBe("report");
      expect(created.outcome).toBe("create");
      expect(reused.outcome).toBe("reuse");
      expect(reused.selection).toEqual(created.selection);
      service.close();
    });
  }

  it("persists stack configuration and reserves ports globally", async () => {
    const root = makeRoot();
    const service = makePersistentService(root);
    const first = await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root, "first"),
    });
    const second = await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root, "second"),
    });

    const configured = await service.updateStack(first.stack.id, {
      runtimeRequest: "native",
      runtime: "native",
      lifecycle: "running",
      ports: [{ key: "db.port", port: 54_322, intent: "automatic" }],
      serviceVersions: { postgres: "17.6.1.143", storage: "1.28.0" },
      runtimeMetadata: {
        pid: 42,
        socketPath: "/tmp/managed.sock",
        processIds: { postgres: 43 },
        containerIds: { storage: "storage-container" },
      },
      configFingerprint: "fingerprint-v2",
      credentialsReference: "credential-record-v2",
    });

    expect(configured).toMatchObject({
      runtimeRequest: "native",
      runtime: "native",
      lifecycle: "running",
      serviceVersions: { postgres: "17.6.1.143", storage: "1.28.0" },
      configFingerprint: "fingerprint-v2",
      credentialsReference: "credential-record-v2",
    });
    expect(configured.runtimeMetadata.processIds).toEqual({ postgres: 43 });

    await expect(
      service.updateStack(second.stack.id, {
        ports: [{ key: "db.port", port: 54_322, intent: "exact" }],
      }),
    ).rejects.toBeInstanceOf(ManagedPortReservationError);
    expect(service.inspectStack(second.stack.id)?.ports).toEqual([]);
    service.close();
  });

  it("rolls back an in-memory registration when its initial port reservation conflicts", async () => {
    const root = makeRoot();
    const service = makeInMemoryService(root);
    await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root, "first"),
      configuration: { ports: [{ key: "api.port", port: 54_321, intent: "exact" }] },
    });
    const secondWorkspace = makeWorkspace(root, "second");

    await expect(
      service.provisionOrdinaryStack({
        workspacePath: secondWorkspace,
        configuration: { ports: [{ key: "api.port", port: 54_321, intent: "exact" }] },
      }),
    ).rejects.toBeInstanceOf(ManagedPortReservationError);
    expect(service.repository.listCheckoutLocations()).toHaveLength(1);
    expect(service.listStacks()).toHaveLength(1);

    const retried = await service.provisionOrdinaryStack({ workspacePath: secondWorkspace });
    expect(retried.outcome).toBe("create");
    expect(service.repository.listCheckoutLocations()).toHaveLength(2);
  });

  it("requires actual runtime inspection before recovering an abandoned operation", async () => {
    const root = makeRoot();
    const service = makeInMemoryService(root);
    const created = await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root),
    });
    const claimed = service.repository.claimOperation({
      token: crypto.randomUUID(),
      stackId: created.stack.id,
      kind: "start",
      now: "2026-08-11T00:00:00.000Z",
    });
    if (!claimed.acquired) {
      throw new Error("Expected to claim an abandoned operation");
    }
    service.repository.updateStack({
      stackId: created.stack.id,
      operationToken: claimed.operation.token,
      lifecycle: "starting",
      now: "2026-08-11T00:00:01.000Z",
    });

    const unknown = await service.reconcileAbandonedOperations({
      inspectRuntime: async () => "unknown",
    });
    expect(unknown.recovered).toEqual([]);
    expect(unknown.retained).toEqual([claimed.operation]);
    expect(service.inspectStack(created.stack.id)?.lifecycle).toBe("starting");

    const reconciled = await service.reconcileAbandonedOperations({
      inspectRuntime: async () => "stopped",
    });
    expect(reconciled.retained).toEqual([]);
    expect(reconciled.recovered).toHaveLength(1);
    expect(service.inspectStack(created.stack.id)?.lifecycle).toBe("stopped");
  });

  it("stops, tombstones, and reclaims one opaque stack ID idempotently", async () => {
    const contract = fixture("reclamation.delete-repeat-is-idempotent");
    const root = makeRoot();
    const service = makePersistentService(root);
    const created = await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root),
      configuration: { lifecycle: "running" },
    });
    writeFileSync(join(created.stack.paths.data, "database"), "owned data");
    let stoppedStackId: string | undefined;

    const deleted = await service.deleteStack(created.stack.id, {
      stop: async (stack) => {
        stoppedStackId = stack.id;
      },
    });
    const repeated = await service.deleteStack(created.stack.id);

    expect(deleted.outcome).toBe("delete");
    expect(stoppedStackId).toBe(created.stack.id);
    expect(existsSync(created.stack.paths.root)).toBe(false);
    expect(repeated.outcome).toBe(contract.expected.outcome);
    expect(service.listStacks()).toEqual([]);
    expect(service.listStacks({ includeTombstoned: true })).toHaveLength(1);
    service.close();
  });

  it("prunes checkout location metadata without touching stack data", async () => {
    const contract = fixture("reclamation.prune-removes-metadata-only");
    const root = makeRoot();
    const service = makePersistentService(root);
    const created = await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root),
    });
    const dataFile = join(created.stack.paths.data, "database");
    writeFileSync(dataFile, "preserve me");

    const pruned = await service.pruneCheckoutLocations(() => true);

    expect(contract.expected.outcome).toBe("update");
    expect(pruned).toBe(1);
    expect(service.repository.listCheckoutLocations()).toEqual([]);
    expect(service.inspectStack(created.stack.id)?.status).toBe("active");
    expect(readFileSync(dataFile, "utf8")).toBe("preserve me");
    service.close();
  });

  it("fails safely when a registry has a newer schema version", () => {
    const root = makeRoot();
    const databasePath = join(root, "future.sqlite3");
    const database = new Database(databasePath, { create: true });
    database.exec("PRAGMA user_version = 999");
    database.close();

    expect(() => openBunSqliteManagedStackRepository(databasePath)).toThrow(
      UnsupportedManagedRegistryVersionError,
    );
  });
});
