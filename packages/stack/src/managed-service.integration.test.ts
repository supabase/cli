import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Context, Effect, ManagedRuntime } from "effect";
import { managedStackContractFixtures } from "./managed-stack-contract.ts";
import { ensureOrdinaryWorkspaceIdentity } from "./managed/identity.ts";
import {
  managedRegistryPath,
  managedStackPaths,
  ordinaryWorkspaceIdentityPath,
} from "./managed/paths.ts";
import {
  DuplicateManagedIdentityError,
  InvalidManagedIdentityError,
  MANAGED_REGISTRY_SCHEMA_VERSION,
  InvalidManagedOwnerPidError,
  ManagedAbandonedOperationError,
  InvalidManagedPortError,
  InvalidManagedStackNameError,
  ManagedPendingStackUpdateError,
  ManagedOperationInProgressError,
  ManagedOperationOwnershipError,
  ManagedPortReservationError,
  ManagedRunningStackPortChangeError,
  ManagedStackInitializationError,
  ManagedStackNotFoundError,
  ManagedStackNotStoppedError,
  ManagedStackPublicationTimeoutError,
  UnsafeManagedStackPathError,
  UnsupportedManagedRegistryVersionError,
  type ManagedStackConfiguration,
  type ManagedStackRecord,
} from "./managed/model.ts";
import { createInMemoryManagedStackRepository } from "./managed/repository-memory.ts";
import { ManagedStackRepository, type ManagedStackRepositoryShape } from "./managed/repository.ts";
import type { MakeManagedStackServiceOptions, ManagedStackServiceHandle } from "./managed-bun.ts";
import {
  bunSqliteManagedStackRepositoryLayer,
  createManagedStackService,
  makeManagedStackService,
} from "./managed-bun.ts";

/**
 * Both registry adapters decide synchronously, so a test can run a contract call
 * the same way the Promise facade's synchronous accessors do.
 */
const runRepo = Effect.runSync;

/**
 * Opens a registry the way production does, as a scoped layer, for the tests that
 * exercise the SQLite adapter itself rather than a managed stack service. The
 * layer's scope owns the database handle, so it stays open until `close`.
 */
const openRegistry = (
  databasePath: string,
): { readonly repository: ManagedStackRepositoryShape; readonly close: () => Promise<void> } => {
  const runtime = ManagedRuntime.make(bunSqliteManagedStackRepositoryLayer(databasePath));
  return {
    repository: Context.get(Effect.runSync(runtime.contextEffect), ManagedStackRepository),
    close: () => runtime.dispose(),
  };
};

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

const findNodeBinary = (): string => {
  const executable = process.platform === "win32" ? "node.exe" : "node";
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    const candidate = join(directory, executable);
    if (!existsSync(candidate)) {
      continue;
    }
    const result = Bun.spawnSync([candidate, "--version"]);
    const version = new TextDecoder().decode(result.stdout).trim();
    if (result.exitCode === 0 && /^v\d+\./.test(version)) {
      return candidate;
    }
  }
  throw new Error("Node is required for the managed SQLite adapter test");
};

type ServiceOverrides = Omit<MakeManagedStackServiceOptions, "repository" | "stateRoot">;

const makeInMemoryService = (
  root: string,
  overrides: ServiceOverrides = {},
): ManagedStackServiceHandle =>
  makeManagedStackService({
    repository: createInMemoryManagedStackRepository(),
    stateRoot: join(root, "managed"),
    publicationPollMs: 1,
    ...overrides,
  });

const makePersistentService = (
  root: string,
  overrides: ServiceOverrides = {},
): ManagedStackServiceHandle =>
  createManagedStackService({
    stateRoot: join(root, "managed"),
    publicationPollMs: 1,
    ...overrides,
  });

/**
 * Valid managed UUIDs whose lexicographic order is the reverse of the order
 * they are handed out in, so a repository that returns insertion order instead
 * of sorting cannot accidentally pass an ordering assertion.
 */
const descendingIdFactory = (): (() => string) => {
  let next = 0xff_ff_ff_00;
  return () => {
    next -= 1;
    return `${next.toString(16).padStart(8, "0")}-0000-7000-8000-000000000000`;
  };
};

const fixture = (id: string) => {
  const scenario = managedStackContractFixtures.find((candidate) => candidate.id === id);
  if (scenario === undefined) {
    throw new Error(`Missing managed stack contract fixture ${id}`);
  }
  return scenario;
};

const portFacts = (id: string) =>
  fixture(id).given.flatMap((fact) => (fact.kind === "config-port" ? [fact] : []));

const portAssignmentFacts = (id: string) =>
  fixture(id).given.flatMap((fact) => (fact.kind === "port-assignment" ? [fact] : []));

const requirePortFact = (id: string, key: string) => {
  const fact = portFacts(id).find((candidate) => candidate.key === key);
  if (fact === undefined || !("value" in fact) || typeof fact.value !== "number") {
    throw new Error(`Fixture ${id} does not define ${key}`);
  }
  return { key: fact.key, port: fact.value, intent: fact.intent };
};

const stackNames = (id: string): ReadonlyArray<string> =>
  fixture(id).given.flatMap((fact) => (fact.kind === "stack-names" ? fact.names : []));

const invalidStackNameCases = managedStackContractFixtures
  .filter(({ id }) => id.startsWith("identity.invalid-stack-name-"))
  .flatMap((scenario) => stackNames(scenario.id).map((name) => [scenario.id, name] as const));

const prepareAbandonedStack = async (
  service: ManagedStackServiceHandle,
  workspace: string,
  ownerPid?: number,
  configuration: ManagedStackConfiguration = {},
) => {
  const identity = (await Effect.runPromise(ensureOrdinaryWorkspaceIdentity(workspace))).identity;
  const stackId = crypto.randomUUID();
  const prepared = runRepo(
    service.repository.prepareOrdinaryStack({
      identity,
      canonicalPath: realpathSync(workspace),
      locationId: crypto.randomUUID(),
      stackId,
      stackName: "default",
      paths: managedStackPaths(service.stateRoot, stackId),
      operationToken: crypto.randomUUID(),
      ownerPid,
      now: "2026-08-11T00:00:00.000Z",
      configuration,
    }),
  );
  if (prepared.outcome !== "create") {
    throw new Error("Expected an abandoned pending stack");
  }
  mkdirSync(prepared.stack.paths.data, { recursive: true });
  return prepared;
};

describe("ordinary-folder managed stack contract", () => {
  it("restricts registry and stack state permissions to the owning user", async () => {
    const root = makeRoot();
    const service = makePersistentService(root);
    const stateRoot = join(root, "managed");
    const { stack } = await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root),
    });
    await service.close();

    const modeOf = (path: string): number => statSync(path).mode & 0o777;
    expect(modeOf(stateRoot)).toBe(0o700);
    expect(modeOf(managedRegistryPath(stateRoot))).toBe(0o600);
    expect(modeOf(stack.paths.data)).toBe(0o700);
    expect(modeOf(stack.paths.logs)).toBe(0o700);
    expect(modeOf(stack.paths.runtime)).toBe(0o700);
  });

  it("retightens managed state permissions left loose by an earlier build", async () => {
    const root = makeRoot();
    const stateRoot = join(root, "managed");
    const registryPath = managedRegistryPath(stateRoot);
    mkdirSync(stateRoot, { recursive: true, mode: 0o755 });
    writeFileSync(registryPath, "", { mode: 0o644 });

    const service = makePersistentService(root);
    await service.close();

    const modeOf = (path: string): number => statSync(path).mode & 0o777;
    expect(modeOf(stateRoot)).toBe(0o700);
    expect(modeOf(registryPath)).toBe(0o600);
  });

  it("keeps read-only discovery registration-free", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = makeInMemoryService(root);

    const result = await service.inspectOrdinaryWorkspace(workspace);

    expect(result).toEqual({ registered: false, stacks: [] });
    expect(existsSync(ordinaryWorkspaceIdentityPath(workspace))).toBe(false);
    expect(runRepo(service.repository.listStacks())).toEqual([]);
    expect(runRepo(service.repository.listCheckoutLocations())).toEqual([]);
  });

  it("reports an existing identity without stacks as not yet registered", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = makeInMemoryService(root);
    const marker = await Effect.runPromise(ensureOrdinaryWorkspaceIdentity(workspace));

    const result = await service.inspectOrdinaryWorkspace(workspace);

    expect(result).toEqual({ registered: false, identity: marker.identity, stacks: [] });
  });

  it("filters inspected stacks by the complete project, checkout, and context identity", async () => {
    const root = makeRoot();
    const repository = createInMemoryManagedStackRepository();
    let foreignContextStack: ManagedStackRecord | undefined;
    const filteringRepository: ManagedStackRepositoryShape = {
      ...repository,
      listStacks: (options) =>
        Effect.map(repository.listStacks(options), (stacks) =>
          foreignContextStack === undefined ? stacks : [...stacks, foreignContextStack],
        ),
    };
    const service = makeManagedStackService({
      repository: filteringRepository,
      stateRoot: join(root, "managed"),
    });
    const created = await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root),
    });
    foreignContextStack = {
      ...created.stack,
      id: crypto.randomUUID(),
      contextId: crypto.randomUUID(),
    };

    const result = await service.inspectOrdinaryWorkspace(join(root, "workspace"));

    expect(result.registered).toBe(true);
    expect(result.stacks).toEqual([created.stack]);
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
    expect(runRepo(service.repository.listStacks())).toEqual([]);
    expect(runRepo(service.repository.listCheckoutLocations())).toEqual([]);
  });

  it.each(invalidStackNameCases)("rejects %s", async (_fixtureId, stackName) => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = makeInMemoryService(root);

    const provision = service.provisionOrdinaryStack({ workspacePath: workspace, stackName });
    await expect(provision).rejects.toBeInstanceOf(InvalidManagedStackNameError);
    await expect(provision).rejects.toThrow(`Invalid managed stack name: ${stackName}`);
    expect(existsSync(ordinaryWorkspaceIdentityPath(workspace))).toBe(false);
    expect(service.listStacks()).toEqual([]);
  });

  it("resolves every valid fixture stack name within one ordinary context", async () => {
    const names = stackNames("identity.valid-stack-names-resolve-deterministically");
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = makeInMemoryService(root);

    const results = await Promise.all(
      names.map((stackName) =>
        service.provisionOrdinaryStack({ workspacePath: workspace, stackName }),
      ),
    );

    expect(results.map(({ stack }) => stack.name)).toEqual(names);
    expect(new Set(results.map(({ stack }) => stack.id)).size).toBe(names.length);
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

    await service.close();
    const reopened = makePersistentService(root);
    const reused = await reopened.provisionOrdinaryStack({ workspacePath: workspace });

    expect(reused.outcome).toBe(recoveredStart.expected.outcome);
    expect(reused.identityMarkerCreated).toBe(false);
    expect(reused.selection).toEqual(created.selection);
    expect(reused.stack.ports).toEqual(created.stack.ports);
    expect(reopened.listStacks()).toHaveLength(1);
    await reopened.close();

    const registry = new Database(managedRegistryPath(join(root, "managed")));
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
    while (runRepo(service.repository.listStacks()).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const second = service.provisionOrdinaryStack({ workspacePath: workspace });
    releaseInitialization();
    const results = await Promise.all([first, second]);

    expect(contract.expected.outcome).toBe("create");
    expect(results.map((result) => result.outcome).sort()).toEqual(["create", "reuse"]);
    expect(new Set(results.map((result) => result.stack.id))).toHaveProperty("size", 1);
    expect(initializerCalls).toBe(1);
    expect(runRepo(service.repository.listStacks())).toHaveLength(1);
    await service.close();
  });

  it("applies the requested configuration after awaiting another caller's publication", async () => {
    const requested = { key: "api.port", port: 55_451, intent: "exact" } as const;
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = makePersistentService(root);
    let releaseInitialization: () => void = () => {};
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });

    const first = service.provisionOrdinaryStack({
      workspacePath: workspace,
      initialize: async () => {
        await initializationGate;
      },
    });
    while (runRepo(service.repository.listStacks()).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const second = service.provisionOrdinaryStack({
      workspacePath: workspace,
      configuration: { ports: [requested], serviceVersions: { postgres: "17.6.1.143" } },
    });
    releaseInitialization();
    const [created, reused] = await Promise.all([first, second]);

    expect(created.outcome).toBe("create");
    expect(reused.outcome).toBe("reuse");
    expect(reused.stack.id).toBe(created.stack.id);
    expect(reused.stack.ports).toEqual([requested]);
    expect(reused.stack.serviceVersions).toEqual({ postgres: "17.6.1.143" });
    expect(service.inspectStack(created.stack.id)).toMatchObject({
      ports: [requested],
      serviceVersions: { postgres: "17.6.1.143" },
    });
    await service.close();
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
    await service.close();
  });

  it("rejects a copied ordinary-folder identity claim", async () => {
    const root = makeRoot();
    const firstWorkspace = makeWorkspace(root, "first");
    const secondWorkspace = makeWorkspace(root, "copy");
    const service = makePersistentService(root);
    await service.provisionOrdinaryStack({ workspacePath: firstWorkspace });
    mkdirSync(join(secondWorkspace, ".supabase"), { recursive: true });
    copyFileSync(
      ordinaryWorkspaceIdentityPath(firstWorkspace),
      ordinaryWorkspaceIdentityPath(secondWorkspace),
    );

    await expect(
      service.provisionOrdinaryStack({ workspacePath: secondWorkspace }),
    ).rejects.toBeInstanceOf(DuplicateManagedIdentityError);
    expect(service.listStacks()).toHaveLength(1);
    expect(runRepo(service.repository.listCheckoutLocations())).toHaveLength(1);
    await service.close();
  });

  it("times out without adopting a pending stack owned by another caller", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = makePersistentService(root, {
      publicationTimeoutMs: 2,
      publicationPollMs: 1,
    });
    await prepareAbandonedStack(service, workspace, process.pid);

    await expect(
      service.provisionOrdinaryStack({ workspacePath: workspace }),
    ).rejects.toBeInstanceOf(ManagedStackPublicationTimeoutError);
    expect(service.listStacks()).toHaveLength(1);
    await service.close();
  });

  it.each([0, -1, 1.5])(
    "reports an abandoned claim instead of waiting on a corrupt stored owner pid %s",
    async (ownerPid) => {
      // A stored pid that is not a pid cannot be asked about: `kill(0, 0)`
      // signals the caller's own process group and a fractional pid throws,
      // either of which would report a dead owner as alive and make provision
      // wait out the whole publication timeout for a publisher that is gone.
      const root = makeRoot();
      const workspace = makeWorkspace(root);
      const repository = createInMemoryManagedStackRepository();
      let livenessProbes = 0;
      const corruptedRepository: ManagedStackRepositoryShape = {
        ...repository,
        prepareOrdinaryStack: (input) =>
          Effect.map(repository.prepareOrdinaryStack(input), (prepared) =>
            prepared.outcome === "existing" && prepared.operation !== undefined
              ? { ...prepared, operation: { ...prepared.operation, ownerPid } }
              : prepared,
          ),
      };
      const service = makeManagedStackService({
        repository: corruptedRepository,
        stateRoot: join(root, "managed"),
        publicationTimeoutMs: 5_000,
        publicationPollMs: 1,
        isProcessAlive: () => {
          livenessProbes += 1;
          return true;
        },
      });
      await prepareAbandonedStack(service, workspace, process.pid);

      await expect(
        service.provisionOrdinaryStack({ workspacePath: workspace }),
      ).rejects.toBeInstanceOf(ManagedAbandonedOperationError);

      expect(livenessProbes).toBe(0);
      await service.close();
    },
  );

  it("keeps polling at a configured interval slower than the internal backoff ceiling", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const repository = createInMemoryManagedStackRepository();
    const pollTimes: Array<number> = [];
    const observedRepository: ManagedStackRepositoryShape = {
      ...repository,
      getStack: (stackId) =>
        Effect.suspend(() => {
          pollTimes.push(performance.now());
          return repository.getStack(stackId);
        }),
    };
    const service = makeManagedStackService({
      repository: observedRepository,
      stateRoot: join(root, "managed"),
      publicationTimeoutMs: 1_600,
      publicationPollMs: 400,
      isProcessAlive: () => true,
    });
    await prepareAbandonedStack(service, workspace, process.pid);

    await expect(
      service.provisionOrdinaryStack({ workspacePath: workspace }),
    ).rejects.toBeInstanceOf(ManagedStackPublicationTimeoutError);

    // The backoff ceiling must never poll a publisher faster than the caller
    // asked for; only the last wait may be shortened, by the deadline.
    expect(pollTimes.length).toBeGreaterThanOrEqual(2);
    const gaps = pollTimes.slice(1).map((time, index) => time - (pollTimes[index] ?? 0));
    expect(gaps.slice(0, 2).every((gap) => gap >= 350)).toBe(true);
    await service.close();
  });

  it("rejects a non-UUID stack factory result before deriving state paths", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    await Effect.runPromise(ensureOrdinaryWorkspaceIdentity(workspace));
    const service = makeManagedStackService({
      repository: createInMemoryManagedStackRepository(),
      stateRoot: join(root, "managed"),
      idFactory: () => "../../outside",
    });

    await expect(
      service.provisionOrdinaryStack({ workspacePath: workspace }),
    ).rejects.toBeInstanceOf(InvalidManagedIdentityError);
    expect(existsSync(join(root, "outside"))).toBe(false);
    expect(service.listStacks()).toEqual([]);
  });
});

describe("managed service options", () => {
  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["tab", "\t"],
  ])(
    "refuses an %s state root instead of falling back to the working directory",
    (_case, stateRoot) => {
      expect(() =>
        makeManagedStackService({
          repository: createInMemoryManagedStackRepository(),
          stateRoot,
        }),
      ).toThrow(UnsafeManagedStackPathError);
    },
  );

  it("refuses an undefined state root instead of falling back to SUPABASE_HOME or the home directory", () => {
    // `stateRoot` is required in the option type, but a caller bypassing the
    // type system (or a plain-JS caller) could still pass `undefined`. That
    // must fail loudly instead of silently resolving against SUPABASE_HOME or
    // the user's home directory.
    const root = makeRoot();
    const configuredHome = join(root, "unused-supabase-home");
    const originalSupabaseHome = process.env["SUPABASE_HOME"];
    process.env["SUPABASE_HOME"] = configuredHome;
    try {
      expect(() =>
        makeManagedStackService({
          repository: createInMemoryManagedStackRepository(),
          stateRoot: undefined,
        } as unknown as MakeManagedStackServiceOptions),
      ).toThrow(UnsafeManagedStackPathError);
      expect(existsSync(configuredHome)).toBe(false);
    } finally {
      if (originalSupabaseHome === undefined) {
        delete process.env["SUPABASE_HOME"];
      } else {
        process.env["SUPABASE_HOME"] = originalSupabaseHome;
      }
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %s as an operation owner pid",
    (ownerPid) => {
      const root = makeRoot();
      expect(() =>
        makeManagedStackService({
          repository: createInMemoryManagedStackRepository(),
          stateRoot: join(root, "managed"),
          ownerPid,
        }),
      ).toThrow(InvalidManagedOwnerPidError);
    },
  );

  it("validates owner pids on the shared entrypoint options path too", async () => {
    const root = makeRoot();
    expect(() =>
      createManagedStackService({
        repository: createInMemoryManagedStackRepository(),
        stateRoot: join(root, "managed"),
        ownerPid: 0,
      }),
    ).toThrow(InvalidManagedOwnerPidError);

    const service = createManagedStackService({
      repository: createInMemoryManagedStackRepository(),
      stateRoot: join(root, "managed"),
      ownerPid: 4321,
    });
    expect(service.stateRoot).toBe(join(root, "managed"));
    await service.close();
  });
});

describe("managed repository and lifecycle", () => {
  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`orders records identically byte-for-byte with the ${adapter} adapter`, async () => {
      // Both adapters must agree on ordering: SQLite sorts `created_at, id`
      // with BINARY collation, so the in-memory repository may not use
      // `localeCompare`, whose case-insensitive collation disagrees on
      // mixed-case paths. Descending IDs make insertion order the wrong answer.
      const root = makeRoot();
      const overrides = {
        clock: () => new Date("2026-08-11T00:00:00.000Z"),
        idFactory: descendingIdFactory(),
      };
      const service =
        adapter === "in-memory"
          ? makeInMemoryService(root, overrides)
          : makePersistentService(root, overrides);
      const first = await service.provisionOrdinaryStack({
        workspacePath: makeWorkspace(root, "Projects"),
      });
      const second = await service.provisionOrdinaryStack({
        workspacePath: makeWorkspace(root, "apps"),
      });

      expect(first.stack.createdAt).toBe(second.stack.createdAt);
      expect(second.stack.id < first.stack.id).toBe(true);
      expect(service.listStacks().map((stack) => stack.id)).toEqual(
        [first.stack.id, second.stack.id].sort(),
      );

      const paths = runRepo(service.repository.listCheckoutLocations()).map(
        (location) => location.canonicalPath,
      );
      expect(paths).toEqual([...paths].sort());
      expect(paths).toHaveLength(2);
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
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
      await service.close();
    });
  }

  it("anchors an injected relative state root so a later chdir cannot split stack state", async () => {
    const service = makeManagedStackService({
      repository: createInMemoryManagedStackRepository(),
      stateRoot: "relative-managed-state",
    });
    expect(service.stateRoot).toBe(resolve("relative-managed-state"));
    await service.close();
  });

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`rejects unusable port numbers with a coded failure for the ${adapter} adapter`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory" ? makeInMemoryService(root) : makePersistentService(root);
      const workspace = makeWorkspace(root);

      await expect(
        service.provisionOrdinaryStack({
          workspacePath: workspace,
          configuration: { ports: [{ key: "api.port", port: 54_321.5, intent: "exact" }] },
        }),
      ).rejects.toBeInstanceOf(InvalidManagedPortError);

      const created = await service.provisionOrdinaryStack({ workspacePath: workspace });
      await expect(
        service.updateStack(created.stack.id, {
          ports: [{ key: "api.port", port: 70_000, intent: "exact" }],
        }),
      ).rejects.toBeInstanceOf(InvalidManagedPortError);
      expect(service.inspectStack(created.stack.id)?.ports).toEqual([]);
      await service.close();
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
        lifecycle: "starting",
        ports: [{ key: "db.port", port: 54_322, intent: "exact" }],
      }),
    ).rejects.toBeInstanceOf(ManagedPortReservationError);
    expect(service.inspectStack(second.stack.id)?.ports).toEqual([]);
    await service.close();
  });

  it("rolls back an in-memory registration when its initial port reservation conflicts", async () => {
    const root = makeRoot();
    const service = makeInMemoryService(root);
    await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root, "first"),
      configuration: {
        lifecycle: "running",
        ports: [{ key: "api.port", port: 54_321, intent: "exact" }],
      },
    });
    const secondWorkspace = makeWorkspace(root, "second");

    await expect(
      service.provisionOrdinaryStack({
        workspacePath: secondWorkspace,
        configuration: {
          lifecycle: "starting",
          ports: [{ key: "api.port", port: 54_321, intent: "exact" }],
        },
      }),
    ).rejects.toBeInstanceOf(ManagedPortReservationError);
    expect(runRepo(service.repository.listCheckoutLocations())).toHaveLength(1);
    expect(service.listStacks()).toHaveLength(1);

    const retried = await service.provisionOrdinaryStack({ workspacePath: secondWorkspace });
    expect(retried.outcome).toBe("create");
    expect(runRepo(service.repository.listCheckoutLocations())).toHaveLength(2);
  });

  it("requires actual runtime inspection before recovering an abandoned operation", async () => {
    const root = makeRoot();
    const service = makeInMemoryService(root, { isProcessAlive: () => false });
    const created = await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root),
    });
    const claimed = runRepo(
      service.repository.claimOperation({
        token: crypto.randomUUID(),
        stackId: created.stack.id,
        kind: "start",
        ownerPid: 987_654,
        now: "2026-08-11T00:00:00.000Z",
      }),
    );
    if (!claimed.acquired) {
      throw new Error("Expected to claim an abandoned operation");
    }
    runRepo(
      service.repository.updateStack({
        stackId: created.stack.id,
        operationToken: claimed.operation.token,
        lifecycle: "starting",
        now: "2026-08-11T00:00:01.000Z",
      }),
    );

    const unknown = await service.reconcileAbandonedOperations({
      inspectRuntime: async () => "unknown",
    });
    expect(unknown.recovered).toEqual([]);
    expect(unknown.abortedStackIds).toEqual([]);
    expect(unknown.retained).toEqual([{ operation: claimed.operation, reason: "runtime-unknown" }]);
    expect(service.inspectStack(created.stack.id)?.lifecycle).toBe("starting");

    const reconciled = await service.reconcileAbandonedOperations({
      inspectRuntime: async () => "stopped",
    });
    expect(reconciled.retained).toEqual([]);
    expect(reconciled.abortedStackIds).toEqual([]);
    expect(reconciled.recovered).toHaveLength(1);
    expect(service.inspectStack(created.stack.id)?.lifecycle).toBe("stopped");
  });

  it("aborts a crashed pending provision and makes the identity retryable", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = makePersistentService(root, {
      isProcessAlive: () => false,
    });
    const pending = await prepareAbandonedStack(service, workspace, 987_650);
    writeFileSync(join(pending.stack.paths.data, "partial"), "incomplete");

    const reconciled = await service.reconcileAbandonedOperations({
      inspectRuntime: async () => "stopped",
    });

    expect(reconciled.abortedStackIds).toEqual([pending.stack.id]);
    expect(reconciled.recovered).toEqual([]);
    expect(reconciled.retained).toEqual([]);
    expect(existsSync(pending.stack.paths.root)).toBe(false);
    expect(service.listStacks()).toEqual([]);

    const retried = await service.provisionOrdinaryStack({ workspacePath: workspace });
    expect(retried.outcome).toBe("create");
    expect(retried.stack.id).not.toBe(pending.stack.id);
    await service.close();
  });

  it("publishes a crashed pending provision when runtime inspection finds it running", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = makePersistentService(root, {
      isProcessAlive: () => false,
    });
    const pending = await prepareAbandonedStack(service, workspace, 987_651);

    const reconciled = await service.reconcileAbandonedOperations({
      inspectRuntime: async () => "running",
    });

    expect(reconciled.abortedStackIds).toEqual([]);
    expect(reconciled.recovered).toHaveLength(1);
    expect(reconciled.recovered[0]).toMatchObject({ status: "active", lifecycle: "running" });
    const reused = await service.provisionOrdinaryStack({ workspacePath: workspace });
    expect(reused.outcome).toBe("reuse");
    expect(reused.stack.id).toBe(pending.stack.id);
    await service.close();
  });

  it("retains operations while their owner process is still alive", async () => {
    const root = makeRoot();
    const service = makeInMemoryService(root, {
      isProcessAlive: (pid) => pid === 987_652,
    });
    const pending = await prepareAbandonedStack(service, makeWorkspace(root), 987_652);
    let inspected = false;

    const reconciled = await service.reconcileAbandonedOperations({
      inspectRuntime: async () => {
        inspected = true;
        return "stopped";
      },
    });

    expect(inspected).toBe(false);
    expect(reconciled.retained).toEqual([{ operation: pending.operation, reason: "owner-alive" }]);
    expect(service.inspectStack(pending.stack.id)?.status).toBe("pending");
  });

  it("force-recovers an operation when a stale or reused PID still appears alive", async () => {
    const root = makeRoot();
    const service = makeInMemoryService(root, { isProcessAlive: () => true });
    const pending = await prepareAbandonedStack(service, makeWorkspace(root), 987_652);

    const retained = await service.reconcileAbandonedOperations({
      inspectRuntime: async () => "stopped",
    });
    expect(retained.retained).toEqual([{ operation: pending.operation, reason: "owner-alive" }]);

    const forced = await service.reconcileAbandonedOperations({
      force: {
        stackId: pending.stack.id,
        operationToken: pending.operation.token,
      },
      inspectRuntime: async () => "stopped",
    });
    expect(forced.abortedStackIds).toEqual([pending.stack.id]);
    expect(forced.retained).toEqual([]);
    expect(service.listStacks()).toEqual([]);
  });

  it.each([
    ["stack ID", { stackId: "not-a-uuid", operationToken: crypto.randomUUID() }],
    ["operation token", { stackId: crypto.randomUUID(), operationToken: "not-a-uuid" }],
  ])("rejects a forced recovery with an invalid %s", async (_label, force) => {
    const root = makeRoot();
    const service = makeInMemoryService(root);
    let inspected = false;

    await expect(
      service.reconcileAbandonedOperations({
        force,
        inspectRuntime: async () => {
          inspected = true;
          return "stopped";
        },
      }),
    ).rejects.toBeInstanceOf(InvalidManagedIdentityError);
    expect(inspected).toBe(false);
  });

  it("scopes forced recovery to one exact operation", async () => {
    const root = makeRoot();
    const service = makeInMemoryService(root, { isProcessAlive: () => true });
    const pending = await Promise.all(
      ["first", "target", "third"].map((name, index) =>
        prepareAbandonedStack(service, makeWorkspace(root, name), 987_660 + index),
      ),
    );
    const target = pending[1];
    if (target === undefined) {
      throw new Error("Expected a target operation");
    }
    const inspected: Array<string> = [];

    const staleTarget = await service.reconcileAbandonedOperations({
      force: {
        stackId: target.stack.id,
        operationToken: crypto.randomUUID(),
      },
      inspectRuntime: async (stack) => {
        inspected.push(stack.id);
        return "stopped";
      },
    });

    expect(staleTarget.abortedStackIds).toEqual([]);
    expect(inspected).toEqual([]);
    expect(runRepo(service.repository.listActiveOperations())).toHaveLength(3);

    const forced = await service.reconcileAbandonedOperations({
      force: {
        stackId: target.stack.id,
        operationToken: target.operation.token,
      },
      inspectRuntime: async (stack) => {
        inspected.push(stack.id);
        return "stopped";
      },
    });

    expect(inspected).toEqual([target.stack.id]);
    expect(forced.abortedStackIds).toEqual([target.stack.id]);
    expect(
      runRepo(service.repository.listActiveOperations())
        .map(({ token }) => token)
        .sort(),
    ).toEqual(
      pending
        .filter(({ stack }) => stack.id !== target.stack.id)
        .map(({ operation }) => operation.token)
        .sort(),
    );
    expect(
      service
        .listStacks()
        .map(({ id }) => id)
        .sort(),
    ).toEqual(
      pending
        .filter(({ stack }) => stack.id !== target.stack.id)
        .map(({ stack }) => stack.id)
        .sort(),
    );
  });

  it("reconciles repository operations that have no owner PID", async () => {
    const root = makeRoot();
    const service = makeInMemoryService(root, { isProcessAlive: () => true });
    const pending = await prepareAbandonedStack(service, makeWorkspace(root));

    const reconciled = await service.reconcileAbandonedOperations({
      inspectRuntime: async () => "stopped",
    });

    expect(reconciled.abortedStackIds).toEqual([pending.stack.id]);
    expect(reconciled.retained).toEqual([]);
  });

  it("does not reclaim data when another recovery pass adopts the pending stack", async () => {
    const root = makeRoot();
    const service = makePersistentService(root, { isProcessAlive: () => false });
    const pending = await prepareAbandonedStack(service, makeWorkspace(root), 987_653);
    const dataFile = join(pending.stack.paths.data, "database");
    writeFileSync(dataFile, "live data");

    const reconciled = await service.reconcileAbandonedOperations({
      inspectRuntime: async (stack, operation) => {
        runRepo(
          service.repository.reconcileOperation(
            stack.id,
            operation.token,
            "running",
            "2026-08-11T00:00:01.000Z",
          ),
        );
        return "stopped";
      },
    });

    expect(reconciled.abortedStackIds).toEqual([]);
    expect(reconciled.recovered).toEqual([]);
    expect(reconciled.skippedOperationIds).toEqual([pending.operation.token]);
    expect(service.inspectStack(pending.stack.id)).toMatchObject({
      status: "active",
      lifecycle: "running",
    });
    expect(readFileSync(dataFile, "utf8")).toBe("live data");
    await service.close();
  });

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`keeps provisioned data when recovery adopts the stack first with ${adapter}`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory"
          ? makeInMemoryService(root, { isProcessAlive: () => false })
          : makePersistentService(root, { isProcessAlive: () => false });
      let stackRoot: string | undefined;
      let dataFile: string | undefined;

      await expect(
        service.provisionOrdinaryStack({
          workspacePath: makeWorkspace(root),
          initialize: async (stack) => {
            stackRoot = stack.paths.root;
            dataFile = join(stack.paths.data, "database");
            writeFileSync(dataFile, "live data");
            const operation = runRepo(service.repository.listActiveOperations()).find(
              (candidate) => candidate.stackId === stack.id,
            );
            if (operation === undefined) {
              throw new Error("Expected the provision operation to remain active");
            }
            runRepo(
              service.repository.reconcileOperation(
                stack.id,
                operation.token,
                "running",
                "2026-08-11T00:00:01.000Z",
              ),
            );
          },
        }),
      ).rejects.toMatchObject({
        cleanupErrors: [expect.any(ManagedOperationOwnershipError)],
      });

      expect(stackRoot).toBeDefined();
      expect(dataFile).toBeDefined();
      expect(existsSync(stackRoot ?? "")).toBe(true);
      expect(readFileSync(dataFile ?? "", "utf8")).toBe("live data");
      expect(service.listStacks()).toEqual([
        expect.objectContaining({ status: "active", lifecycle: "running" }),
      ]);
      await service.close();
    });
  }

  it("retains an operation when owner liveness cannot be determined", async () => {
    const root = makeRoot();
    const livenessError = new Error("liveness unavailable");
    const service = makeInMemoryService(root, {
      isProcessAlive: () => {
        throw livenessError;
      },
    });
    const pending = await prepareAbandonedStack(service, makeWorkspace(root), 987_670);

    const reconciled = await service.reconcileAbandonedOperations({
      inspectRuntime: async () => "stopped",
    });

    expect(reconciled.retained).toEqual([
      {
        operation: pending.operation,
        reason: "owner-liveness-unknown",
        error: livenessError,
      },
    ]);
  });

  it("retains an operation when runtime inspection fails", async () => {
    const root = makeRoot();
    const inspectionError = new Error("runtime unavailable");
    const service = makeInMemoryService(root, { isProcessAlive: () => false });
    const pending = await prepareAbandonedStack(service, makeWorkspace(root), 987_671);

    const reconciled = await service.reconcileAbandonedOperations({
      inspectRuntime: async () => {
        throw inspectionError;
      },
    });

    expect(reconciled.retained).toEqual([
      {
        operation: pending.operation,
        reason: "runtime-inspection-failed",
        error: inspectionError,
      },
    ]);
    expect(runRepo(service.repository.listActiveOperations())).toEqual([pending.operation]);
  });

  it("reports a failed post-abort state reclamation", async () => {
    const root = makeRoot();
    const repository = createInMemoryManagedStackRepository();
    let returnUnsafePath = false;
    const unsafeRoot = join(root, "outside");
    const guardedRepository: ManagedStackRepositoryShape = {
      ...repository,
      getStack: (stackId) =>
        Effect.map(repository.getStack(stackId), (stack) =>
          stack === undefined || !returnUnsafePath
            ? stack
            : {
                ...stack,
                paths: {
                  root: unsafeRoot,
                  data: join(unsafeRoot, "data"),
                  logs: join(unsafeRoot, "logs"),
                  runtime: join(unsafeRoot, "runtime"),
                },
              },
        ),
    };
    const service = makeManagedStackService({
      repository: guardedRepository,
      stateRoot: join(root, "managed"),
      isProcessAlive: () => false,
    });
    const pending = await prepareAbandonedStack(service, makeWorkspace(root), 987_672);
    returnUnsafePath = true;

    const reconciled = await service.reconcileAbandonedOperations({
      inspectRuntime: async () => "stopped",
    });

    // The claim is released and the pending row is gone, but the leaked data is
    // still there, so the stack is reported as a reclamation failure only.
    expect(reconciled.abortedStackIds).toEqual([]);
    expect(reconciled.failures).toEqual([
      {
        operation: pending.operation,
        phase: "state-reclamation",
        operationReleased: true,
        error: expect.any(UnsafeManagedStackPathError),
      },
    ]);
    expect(service.listStacks()).toEqual([]);
  });

  it("continues recovery when an owner finishes one operation during inspection", async () => {
    const root = makeRoot();
    const service = makeInMemoryService(root, { isProcessAlive: () => false });
    const first = await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root, "first"),
    });
    const second = await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root, "second"),
    });
    const firstOperation = runRepo(
      service.repository.claimOperation({
        token: crypto.randomUUID(),
        stackId: first.stack.id,
        kind: "start",
        ownerPid: 987_653,
        now: "2026-08-11T00:00:00.000Z",
      }),
    );
    const secondOperation = runRepo(
      service.repository.claimOperation({
        token: crypto.randomUUID(),
        stackId: second.stack.id,
        kind: "start",
        ownerPid: 987_654,
        now: "2026-08-11T00:00:01.000Z",
      }),
    );
    if (!firstOperation.acquired || !secondOperation.acquired) {
      throw new Error("Expected both recovery operations to be claimed");
    }

    const reconciled = await service.reconcileAbandonedOperations({
      inspectRuntime: async (stack, operation) => {
        if (stack.id === first.stack.id) {
          runRepo(
            service.repository.finishOperation(
              stack.id,
              operation.token,
              "completed",
              "2026-08-11T00:00:02.000Z",
            ),
          );
        }
        return "stopped";
      },
    });

    expect(reconciled.retained).toEqual([]);
    expect(reconciled.recovered.map((stack) => stack.id)).toEqual([second.stack.id]);
    expect(reconciled.skippedOperationIds).toEqual([firstOperation.operation.token]);
  });

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`keeps a failed pending adoption retryable with ${adapter}`, async () => {
      const root = makeRoot();
      const overrides = { isProcessAlive: () => false };
      const service =
        adapter === "in-memory"
          ? makeInMemoryService(root, overrides)
          : makePersistentService(root, overrides);
      const owner = await service.provisionOrdinaryStack({
        workspacePath: makeWorkspace(root, "owner"),
        configuration: {
          lifecycle: "running",
          ports: [{ key: "api.port", port: 55_409, intent: "exact" }],
        },
      });
      const pending = await prepareAbandonedStack(
        service,
        makeWorkspace(root, "pending"),
        987_673,
        { ports: [{ key: "api.port", port: 55_409, intent: "exact" }] },
      );

      const blocked = await service.reconcileAbandonedOperations({
        inspectRuntime: async () => "running",
      });

      expect(blocked.failures).toEqual([
        {
          operation: pending.operation,
          phase: "reconciliation",
          operationReleased: false,
          error: expect.any(ManagedPortReservationError),
        },
      ]);
      expect(service.inspectStack(pending.stack.id)).toMatchObject({
        status: "pending",
        lifecycle: "stopped",
      });
      expect(runRepo(service.repository.listActiveOperations())).toEqual([pending.operation]);

      await service.updateStack(owner.stack.id, { lifecycle: "stopped" });
      const retried = await service.reconcileAbandonedOperations({
        inspectRuntime: async () => "running",
      });

      expect(retried.recovered).toEqual([
        expect.objectContaining({
          id: pending.stack.id,
          status: "active",
          lifecycle: "running",
        }),
      ]);
      expect(retried.failures).toEqual([]);
      expect(runRepo(service.repository.listActiveOperations())).toEqual([]);
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`releases a failed runtime adoption operation with ${adapter}`, async () => {
      const root = makeRoot();
      const overrides = { isProcessAlive: () => false };
      const service =
        adapter === "in-memory"
          ? makeInMemoryService(root, overrides)
          : makePersistentService(root, overrides);
      await service.provisionOrdinaryStack({
        workspacePath: makeWorkspace(root, "owner"),
        configuration: {
          lifecycle: "running",
          ports: [{ key: "api.port", port: 55_410, intent: "exact" }],
        },
      });
      const blocked = await service.provisionOrdinaryStack({
        workspacePath: makeWorkspace(root, "blocked"),
        configuration: {
          ports: [{ key: "api.port", port: 55_410, intent: "exact" }],
        },
      });
      const operation = runRepo(
        service.repository.claimOperation({
          token: crypto.randomUUID(),
          stackId: blocked.stack.id,
          kind: "start",
          ownerPid: 987_654,
          now: "2026-08-11T00:00:00.000Z",
        }),
      );
      if (!operation.acquired) {
        throw new Error("Expected the abandoned start operation to be claimed");
      }

      const reconciled = await service.reconcileAbandonedOperations({
        inspectRuntime: async () => "running",
      });

      expect(reconciled.failures).toHaveLength(1);
      expect(reconciled.failures[0]).toMatchObject({
        operation: operation.operation,
        phase: "reconciliation",
        operationReleased: true,
        error: expect.any(ManagedPortReservationError),
      });
      expect(runRepo(service.repository.listActiveOperations())).toEqual([]);
      expect(service.inspectStack(blocked.stack.id)?.lifecycle).toBe("failed");
      await expect(
        service.deleteStack(blocked.stack.id, { stop: async () => {} }),
      ).resolves.toMatchObject({
        outcome: "delete",
      });
      await service.close();
    });
  }

  it("applies exact stopped-stack ports and makes removed exact keys sticky", async () => {
    const changedFixtureId = "ports.config-change-on-stopped-stack-applies";
    const removedFixtureId = "ports.removing-exact-key-keeps-current-port-sticky";
    const previous = portAssignmentFacts(changedFixtureId)[0];
    const requested = requirePortFact(changedFixtureId, "api.port");
    if (previous === undefined) {
      throw new Error(`Fixture ${changedFixtureId} has no persisted assignment`);
    }
    const root = makeRoot();
    const service = makePersistentService(root);
    await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root),
      configuration: {
        ports: [{ key: previous.key, port: previous.port, intent: previous.intent }],
      },
    });

    const changed = await service.provisionOrdinaryStack({
      workspacePath: join(root, "workspace"),
      configuration: { ports: [requested] },
    });
    expect(changed.outcome).toBe("reuse");
    expect(changed.stack.ports).toEqual([requested]);

    const removed = portFacts(removedFixtureId).find((fact) => fact.key === "api.port");
    if (removed === undefined) {
      throw new Error(`Fixture ${removedFixtureId} has no api.port intent`);
    }
    const sticky = await service.provisionOrdinaryStack({
      workspacePath: join(root, "workspace"),
      configuration: {
        ports: [{ key: removed.key, port: 60_000, intent: removed.intent }],
      },
    });
    expect(sticky.outcome).toBe("reuse");
    expect(sticky.stack.ports).toEqual([{ ...requested, intent: "automatic" }]);
    await service.close();
  });

  it("rejects port drift while running without overwriting persisted exact intent", async () => {
    const fixtureId = "ports.config-change-on-running-stack-reports-drift";
    const previous = portAssignmentFacts(fixtureId)[0];
    const requested = requirePortFact(fixtureId, "api.port");
    if (previous === undefined) {
      throw new Error(`Fixture ${fixtureId} has no persisted assignment`);
    }
    const root = makeRoot();
    const service = makePersistentService(root);
    const created = await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root),
      configuration: {
        lifecycle: "running",
        ports: [{ key: previous.key, port: previous.port, intent: previous.intent }],
      },
    });

    await expect(
      service.updateStack(created.stack.id, { ports: [requested] }),
    ).rejects.toBeInstanceOf(ManagedRunningStackPortChangeError);
    expect(service.inspectStack(created.stack.id)?.ports).toEqual([
      { key: previous.key, port: previous.port, intent: previous.intent },
    ]);
    await service.close();
  });

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`allows failed-stack recovery and intent-only updates with ${adapter}`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory" ? makeInMemoryService(root) : makePersistentService(root);
      const failed = await service.provisionOrdinaryStack({
        workspacePath: makeWorkspace(root, "failed"),
        configuration: {
          lifecycle: "failed",
          ports: [{ key: "api.port", port: 55_401, intent: "exact" }],
        },
      });

      const restarted = await service.updateStack(failed.stack.id, {
        lifecycle: "starting",
        ports: [{ key: "api.port", port: 55_402, intent: "exact" }],
      });
      expect(restarted).toMatchObject({
        lifecycle: "starting",
        ports: [{ key: "api.port", port: 55_402, intent: "exact" }],
      });

      const running = await service.provisionOrdinaryStack({
        workspacePath: makeWorkspace(root, "running"),
        configuration: {
          lifecycle: "running",
          ports: [{ key: "api.port", port: 55_403, intent: "automatic" }],
        },
      });
      const pinned = await service.updateStack(running.stack.id, {
        ports: [{ key: "api.port", port: 55_403, intent: "exact" }],
      });
      expect(pinned.ports).toEqual([{ key: "api.port", port: 55_403, intent: "exact" }]);

      const stoppedAndChanged = await service.updateStack(running.stack.id, {
        lifecycle: "stopped",
        ports: [{ key: "api.port", port: 55_404, intent: "exact" }],
      });
      expect(stoppedAndChanged).toMatchObject({
        lifecycle: "stopped",
        ports: [{ key: "api.port", port: 55_404, intent: "exact" }],
      });
      await service.close();
    });
  }

  it("keeps stopped sticky assignments soft and claims them only while starting", async () => {
    const stickyContract = fixture("ports.sticky-ports-reuse-on-return");
    const collisionContract = fixture("ports.later-sticky-port-collision-fails");
    const stickyAssignment = portAssignmentFacts(stickyContract.id)[0];
    const collisionAssignment = portAssignmentFacts(collisionContract.id)[0];
    if (stickyAssignment === undefined || collisionAssignment === undefined) {
      throw new Error("Sticky-port fixtures must provide persisted assignments");
    }
    expect(stickyAssignment.port).toBe(collisionAssignment.port);
    const root = makeRoot();
    const service = makePersistentService(root);
    const assignment = {
      key: stickyAssignment.key,
      port: stickyAssignment.port,
      intent: stickyAssignment.intent,
    };
    const first = await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root, "first"),
      configuration: { ports: [assignment] },
    });
    const second = await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root, "second"),
      configuration: { ports: [assignment] },
    });

    await service.updateStack(first.stack.id, { lifecycle: "starting" });
    await expect(
      service.updateStack(second.stack.id, { lifecycle: "starting" }),
    ).rejects.toBeInstanceOf(ManagedPortReservationError);
    expect(collisionContract.expected.outcome).toBe("error");

    await service.updateStack(first.stack.id, { lifecycle: "stopped" });
    const startedSecond = await service.updateStack(second.stack.id, { lifecycle: "starting" });
    expect(startedSecond.ports).toEqual([assignment]);
    expect(stickyContract.expected.outcome).toBe("reuse");
    await service.close();
  });

  it("reports duplicate ports inside one stack as a managed reservation error", async () => {
    const root = makeRoot();
    const service = makePersistentService(root);
    const created = await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root),
    });

    await expect(
      service.updateStack(created.stack.id, {
        lifecycle: "starting",
        ports: [
          { key: "api.port", port: 55_421, intent: "automatic" },
          { key: "db.port", port: 55_421, intent: "automatic" },
        ],
      }),
    ).rejects.toBeInstanceOf(ManagedPortReservationError);
    expect(service.inspectStack(created.stack.id)?.ports).toEqual([]);
    await service.close();
  });

  it("rejects a second operation claim without mutating the stack", async () => {
    const root = makeRoot();
    const service = makeInMemoryService(root);
    const created = await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root),
    });
    const claimed = runRepo(
      service.repository.claimOperation({
        token: crypto.randomUUID(),
        stackId: created.stack.id,
        kind: "start",
        ownerPid: process.pid,
        now: "2026-08-11T00:00:00.000Z",
      }),
    );
    if (!claimed.acquired) {
      throw new Error("Expected the first operation claim to succeed");
    }

    await expect(
      service.updateStack(created.stack.id, { lifecycle: "running" }),
    ).rejects.toBeInstanceOf(ManagedOperationInProgressError);
    expect(service.inspectStack(created.stack.id)?.lifecycle).toBe("stopped");
  });

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`reports missing stacks and operation ownership mismatches with ${adapter}`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory" ? makeInMemoryService(root) : makePersistentService(root);

      await expect(
        service.updateStack(crypto.randomUUID(), { lifecycle: "stopped" }),
      ).rejects.toBeInstanceOf(ManagedStackNotFoundError);

      const created = await service.provisionOrdinaryStack({
        workspacePath: makeWorkspace(root),
      });
      const claimed = runRepo(
        service.repository.claimOperation({
          token: crypto.randomUUID(),
          stackId: created.stack.id,
          kind: "update",
          ownerPid: process.pid,
          now: "2026-08-11T00:00:00.000Z",
        }),
      );
      if (!claimed.acquired) {
        throw new Error("Expected the update operation to be claimed");
      }

      expect(() =>
        runRepo(
          service.repository.finishOperation(
            created.stack.id,
            crypto.randomUUID(),
            "completed",
            "2026-08-11T00:00:01.000Z",
          ),
        ),
      ).toThrow(ManagedOperationOwnershipError);
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`refuses to resurrect a tombstoned stack with ${adapter}`, async () => {
      const reserved = { key: "api.port", port: 55_461, intent: "exact" } as const;
      const root = makeRoot();
      const service =
        adapter === "in-memory" ? makeInMemoryService(root) : makePersistentService(root);
      const deleted = await service.provisionOrdinaryStack({
        workspacePath: makeWorkspace(root, "deleted"),
        configuration: { lifecycle: "running", ports: [reserved] },
      });
      await service.deleteStack(deleted.stack.id, { stop: async () => {} });

      await expect(
        service.updateStack(deleted.stack.id, { lifecycle: "running", ports: [reserved] }),
      ).rejects.toBeInstanceOf(ManagedStackNotFoundError);

      expect(service.inspectStack(deleted.stack.id)).toMatchObject({
        status: "tombstoned",
        lifecycle: "stopped",
        ports: [],
      });
      expect(runRepo(service.repository.listActiveOperations())).toEqual([]);

      const successor = await service.provisionOrdinaryStack({
        workspacePath: makeWorkspace(root, "successor"),
        configuration: { lifecycle: "running", ports: [reserved] },
      });
      expect(successor.stack.ports).toEqual([reserved]);
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    for (const runtime of ["running", "stopped", "unknown"] as const) {
      it(`finishes a crashed delete without resurrecting its tombstone with ${adapter} (${runtime} runtime)`, async () => {
        // A tombstoned row under a claimed operation is a delete that died
        // between tombstoning and releasing its claim. Recovery must finish the
        // deletion, never revive the row into a lifecycle — whatever the
        // runtime inspection reports about the dead owner's processes,
        // including nothing at all.
        const root = makeRoot();
        const overrides = { isProcessAlive: () => false };
        const service =
          adapter === "in-memory"
            ? makeInMemoryService(root, overrides)
            : makePersistentService(root, overrides);
        const created = await service.provisionOrdinaryStack({
          workspacePath: makeWorkspace(root),
        });
        writeFileSync(join(created.stack.paths.data, "database"), "leaked");
        const claimed = runRepo(
          service.repository.claimOperation({
            token: crypto.randomUUID(),
            stackId: created.stack.id,
            kind: "delete",
            ownerPid: 987_680,
            now: "2026-08-11T00:00:00.000Z",
          }),
        );
        if (!claimed.acquired) {
          throw new Error("Expected the delete operation to be claimed");
        }
        runRepo(
          service.repository.tombstoneStack(
            created.stack.id,
            claimed.operation.token,
            "2026-08-11T00:00:01.000Z",
          ),
        );

        const reconciled = await service.reconcileAbandonedOperations({
          inspectRuntime: async () => runtime,
        });

        expect(reconciled.reclaimedStackIds).toEqual([created.stack.id]);
        expect(reconciled.recovered).toEqual([]);
        expect(reconciled.abortedStackIds).toEqual([]);
        expect(reconciled.failures).toEqual([]);
        expect(reconciled.retained).toEqual([]);
        expect(runRepo(service.repository.listActiveOperations())).toEqual([]);
        // The tombstone itself survives: idempotent deletion depends on it.
        expect(service.inspectStack(created.stack.id)).toMatchObject({
          status: "tombstoned",
          lifecycle: "stopped",
          ports: [],
        });
        expect(existsSync(created.stack.paths.root)).toBe(false);

        const repeated = await service.reconcileAbandonedOperations({
          inspectRuntime: async () => runtime,
        });

        expect(repeated).toEqual({
          recovered: [],
          abortedStackIds: [],
          reclaimedStackIds: [],
          retained: [],
          skippedOperationIds: [],
          failures: [],
        });
        expect(service.inspectStack(created.stack.id)?.status).toBe("tombstoned");
        await expect(service.deleteStack(created.stack.id)).resolves.toMatchObject({
          outcome: "no-op",
        });
        await service.close();
      });
    }
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`reclaims a crashed delete without consulting the runtime with ${adapter}`, async () => {
      // Tombstoning zeroes the runtime metadata, so a real inspector can only
      // ever answer "unknown" — or fail — about a crashed deletion. Gating the
      // reclamation on an answer the tombstone destroyed would leak the
      // directory forever, and the tombstoned branch ignores the lifecycle.
      const root = makeRoot();
      const overrides = { isProcessAlive: () => false };
      const service =
        adapter === "in-memory"
          ? makeInMemoryService(root, overrides)
          : makePersistentService(root, overrides);
      const created = await service.provisionOrdinaryStack({
        workspacePath: makeWorkspace(root),
      });
      writeFileSync(join(created.stack.paths.data, "database"), "leaked");
      const claimed = runRepo(
        service.repository.claimOperation({
          token: crypto.randomUUID(),
          stackId: created.stack.id,
          kind: "delete",
          ownerPid: 987_681,
          now: "2026-08-11T00:00:00.000Z",
        }),
      );
      if (!claimed.acquired) {
        throw new Error("Expected the delete operation to be claimed");
      }
      runRepo(
        service.repository.tombstoneStack(
          created.stack.id,
          claimed.operation.token,
          "2026-08-11T00:00:01.000Z",
        ),
      );

      const reconciled = await service.reconcileAbandonedOperations({
        inspectRuntime: async () => {
          throw new Error("runtime inspection is unavailable for a deleted stack");
        },
      });

      expect(reconciled.reclaimedStackIds).toEqual([created.stack.id]);
      expect(reconciled.retained).toEqual([]);
      expect(reconciled.failures).toEqual([]);
      expect(runRepo(service.repository.listActiveOperations())).toEqual([]);
      expect(existsSync(created.stack.paths.root)).toBe(false);
      expect(service.inspectStack(created.stack.id)?.status).toBe("tombstoned");
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`reports a crashed delete as reclaimed only once its data is gone with ${adapter}`, async () => {
      const root = makeRoot();
      const stateRoot = join(root, "managed");
      const outsideRoot = join(root, "outside");
      mkdirSync(outsideRoot, { recursive: true });
      writeFileSync(join(outsideRoot, "preserve"), "safe");
      const registry =
        adapter === "in-memory" ? undefined : openRegistry(managedRegistryPath(stateRoot));
      const repository = registry?.repository ?? createInMemoryManagedStackRepository();
      let forgePath = false;
      const guardedRepository: ManagedStackRepositoryShape = {
        ...repository,
        getStack: (stackId) =>
          Effect.map(repository.getStack(stackId), (stack) =>
            stack === undefined || !forgePath
              ? stack
              : {
                  ...stack,
                  paths: {
                    root: outsideRoot,
                    data: join(outsideRoot, "data"),
                    logs: join(outsideRoot, "logs"),
                    runtime: join(outsideRoot, "runtime"),
                  },
                },
          ),
      };
      const service = makeManagedStackService({
        repository: guardedRepository,
        stateRoot,
        isProcessAlive: () => false,
      });
      const created = await service.provisionOrdinaryStack({
        workspacePath: makeWorkspace(root),
      });
      const claimed = runRepo(
        service.repository.claimOperation({
          token: crypto.randomUUID(),
          stackId: created.stack.id,
          kind: "delete",
          ownerPid: 987_682,
          now: "2026-08-11T00:00:00.000Z",
        }),
      );
      if (!claimed.acquired) {
        throw new Error("Expected the delete operation to be claimed");
      }
      runRepo(
        service.repository.tombstoneStack(
          created.stack.id,
          claimed.operation.token,
          "2026-08-11T00:00:01.000Z",
        ),
      );
      forgePath = true;

      const reconciled = await service.reconcileAbandonedOperations({
        inspectRuntime: async () => "stopped",
      });

      // Reporting the stack as reclaimed before the removal succeeded would tell
      // the caller its leaked data is gone while it is still on disk.
      expect(reconciled.reclaimedStackIds).toEqual([]);
      expect(reconciled.failures).toEqual([
        {
          operation: claimed.operation,
          phase: "state-reclamation",
          operationReleased: true,
          error: expect.any(UnsafeManagedStackPathError),
        },
      ]);
      expect(readFileSync(join(outsideRoot, "preserve"), "utf8")).toBe("safe");
      await service.close();
      await registry?.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`stores port assignments in one canonical key order with ${adapter}`, async () => {
      // SQLite reads ports back with `ORDER BY key`, so the shared reconciler
      // must hand both adapters the same order or a caller's request order
      // would leak into one adapter's records and not the other's.
      const root = makeRoot();
      const service =
        adapter === "in-memory" ? makeInMemoryService(root) : makePersistentService(root);
      const studio = { key: "studio.port", port: 55_501, intent: "exact" } as const;
      const api = { key: "api.port", port: 55_502, intent: "exact" } as const;
      const db = { key: "db.port", port: 55_503, intent: "exact" } as const;
      const sorted = [api, db, studio];

      const created = await service.provisionOrdinaryStack({
        workspacePath: makeWorkspace(root),
        configuration: { ports: [studio, api, db] },
      });

      expect(created.stack.ports).toEqual(sorted);
      expect(service.inspectStack(created.stack.id)?.ports).toEqual(sorted);

      const updated = await service.updateStack(created.stack.id, { ports: [db, studio, api] });

      expect(updated.ports).toEqual(sorted);
      expect(service.inspectStack(created.stack.id)?.ports).toEqual(sorted);
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`breaks active-operation ordering ties by token with ${adapter}`, async () => {
      // Recovery walks this list, so two claims sharing one `startedAt` must not
      // depend on insertion order: SQLite would return rowid order and the
      // in-memory adapter its map order. Descending tokens make insertion order
      // the wrong answer.
      const root = makeRoot();
      const overrides = { clock: () => new Date("2026-08-11T00:00:00.000Z") };
      const service =
        adapter === "in-memory"
          ? makeInMemoryService(root, overrides)
          : makePersistentService(root, overrides);
      const nextToken = descendingIdFactory();
      const tokens: Array<string> = [];
      for (const name of ["first", "second", "third"]) {
        const created = await service.provisionOrdinaryStack({
          workspacePath: makeWorkspace(root, name),
        });
        const token = nextToken();
        const claimed = runRepo(
          service.repository.claimOperation({
            token,
            stackId: created.stack.id,
            kind: "start",
            ownerPid: 987_683,
            now: "2026-08-11T00:00:00.000Z",
          }),
        );
        if (!claimed.acquired) {
          throw new Error("Expected each recovery operation to be claimed");
        }
        tokens.push(token);
      }

      expect(tokens).toEqual([...tokens].sort().reverse());
      expect(runRepo(service.repository.listActiveOperations()).map(({ token }) => token)).toEqual(
        [...tokens].sort(),
      );
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`refuses to persist an unusable owner pid with ${adapter}`, async () => {
      // The pid is only useful because recovery asks the operating system about
      // it, and a value that is not a pid cannot be asked about safely. The
      // repository is the boundary that must never store one.
      const root = makeRoot();
      const service =
        adapter === "in-memory" ? makeInMemoryService(root) : makePersistentService(root);
      const created = await service.provisionOrdinaryStack({
        workspacePath: makeWorkspace(root, "claimed"),
      });

      for (const ownerPid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() =>
          runRepo(
            service.repository.claimOperation({
              token: crypto.randomUUID(),
              stackId: created.stack.id,
              kind: "start",
              ownerPid,
              now: "2026-08-11T00:00:00.000Z",
            }),
          ),
        ).toThrow(InvalidManagedOwnerPidError);
      }
      expect(runRepo(service.repository.listActiveOperations())).toEqual([]);

      await expect(
        prepareAbandonedStack(service, makeWorkspace(root, "prepared"), 0),
      ).rejects.toBeInstanceOf(InvalidManagedOwnerPidError);
      expect(service.listStacks()).toHaveLength(1);
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`refuses to reconfigure an unpublished pending stack with ${adapter}`, async () => {
      // A pending row belongs to its publisher's provisioning flow. Letting a
      // holder of the claim mutate its lifecycle would give a stack that no
      // reader can see a port-occupying lease.
      const root = makeRoot();
      const service =
        adapter === "in-memory" ? makeInMemoryService(root) : makePersistentService(root);
      const pending = await prepareAbandonedStack(service, makeWorkspace(root), process.pid);

      expect(() =>
        runRepo(
          service.repository.updateStack({
            stackId: pending.stack.id,
            operationToken: pending.operation.token,
            now: "2026-08-11T00:00:02.000Z",
            lifecycle: "running",
          }),
        ),
      ).toThrow(ManagedPendingStackUpdateError);

      expect(service.inspectStack(pending.stack.id)).toMatchObject({
        status: "pending",
        lifecycle: "stopped",
      });
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`refuses to delete a running stack without a stop path with ${adapter}`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory" ? makeInMemoryService(root) : makePersistentService(root);
      const created = await service.provisionOrdinaryStack({
        workspacePath: makeWorkspace(root),
        configuration: { lifecycle: "running" },
      });

      await expect(service.deleteStack(created.stack.id)).rejects.toBeInstanceOf(
        ManagedStackNotStoppedError,
      );

      expect(service.inspectStack(created.stack.id)).toMatchObject({
        status: "active",
        lifecycle: "running",
      });
      expect(runRepo(service.repository.listActiveOperations())).toEqual([]);
      await service.close();
    });
  }

  it("re-reads lifecycle after claiming delete before deciding whether to stop", async () => {
    const root = makeRoot();
    const repository = createInMemoryManagedStackRepository();
    let promoteBeforeDelete = true;
    const racingRepository: ManagedStackRepositoryShape = {
      ...repository,
      claimOperation: (input) =>
        Effect.suspend(() => {
          if (input.kind === "delete" && promoteBeforeDelete) {
            promoteBeforeDelete = false;
            const start = runRepo(
              repository.claimOperation({
                token: crypto.randomUUID(),
                stackId: input.stackId,
                kind: "start",
                ownerPid: 123,
                now: input.now,
              }),
            );
            if (!start.acquired) {
              throw new Error("Expected the racing start operation to be claimed");
            }
            runRepo(
              repository.updateStack({
                stackId: input.stackId,
                operationToken: start.operation.token,
                lifecycle: "running",
                now: input.now,
              }),
            );
            runRepo(
              repository.finishOperation(
                input.stackId,
                start.operation.token,
                "completed",
                input.now,
              ),
            );
          }
          return repository.claimOperation(input);
        }),
    };
    const service = makeManagedStackService({
      repository: racingRepository,
      stateRoot: join(root, "managed"),
    });
    const created = await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root),
    });
    let stoppedLifecycle: string | undefined;

    await service.deleteStack(created.stack.id, {
      stop: async (stack) => {
        stoppedLifecycle = stack.lifecycle;
      },
    });

    expect(stoppedLifecycle).toBe("running");
    expect(service.inspectStack(created.stack.id)?.status).toBe("tombstoned");
  });

  it("treats a delete as successful when a concurrent forced recovery already resolved its operation", async () => {
    // Data removal already happened by the time this call closes out the
    // operation, so a concurrent forced recovery racing to resolve the same
    // claim first must not turn an already-completed delete into a failure.
    const root = makeRoot();
    const repository = createInMemoryManagedStackRepository();
    const racingRepository: ManagedStackRepositoryShape = {
      ...repository,
      finishOperation: (stackId, operationToken, outcome, now, error) =>
        outcome === "completed"
          ? Effect.fail(new ManagedOperationOwnershipError({ stackId }))
          : repository.finishOperation(stackId, operationToken, outcome, now, error),
    };
    const service = makeManagedStackService({
      repository: racingRepository,
      stateRoot: join(root, "managed"),
    });
    const created = await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root),
    });

    const deleted = await service.deleteStack(created.stack.id);

    expect(deleted).toMatchObject({
      outcome: "delete",
      dataReclamation: { outcome: "removed" },
    });
    expect(existsSync(created.stack.paths.root)).toBe(false);
    await service.close();
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
    mkdirSync(created.stack.paths.data, { recursive: true });
    writeFileSync(join(created.stack.paths.data, "orphaned-after-delete"), "retry removal");
    const repeated = await service.deleteStack(created.stack.id);

    expect(deleted.outcome).toBe("delete");
    expect(deleted.dataReclamation).toEqual({ outcome: "removed" });
    expect(stoppedStackId).toBe(created.stack.id);
    expect(existsSync(created.stack.paths.root)).toBe(false);
    expect(repeated.outcome).toBe(contract.expected.outcome);
    expect(repeated.dataReclamation).toEqual({ outcome: "removed" });
    expect(service.listStacks()).toEqual([]);
    expect(service.listStacks({ includeTombstoned: true })).toHaveLength(1);
    await service.close();
  });

  it("reports unsafe tombstone data as retained without deleting it", async () => {
    const root = makeRoot();
    const repository = createInMemoryManagedStackRepository();
    let forgePath = false;
    const outsideRoot = join(root, "outside");
    mkdirSync(outsideRoot);
    writeFileSync(join(outsideRoot, "preserve"), "safe");
    const guardedRepository: ManagedStackRepositoryShape = {
      ...repository,
      getStack: (stackId) =>
        Effect.map(repository.getStack(stackId), (stack) =>
          stack === undefined || !forgePath
            ? stack
            : {
                ...stack,
                paths: {
                  root: outsideRoot,
                  data: join(outsideRoot, "data"),
                  logs: join(outsideRoot, "logs"),
                  runtime: join(outsideRoot, "runtime"),
                },
              },
        ),
    };
    const service = makeManagedStackService({
      repository: guardedRepository,
      stateRoot: join(root, "managed"),
    });
    const created = await service.provisionOrdinaryStack({
      workspacePath: makeWorkspace(root),
    });
    await service.deleteStack(created.stack.id);
    forgePath = true;

    const repeated = await service.deleteStack(created.stack.id);

    expect(repeated).toMatchObject({
      outcome: "no-op",
      dataReclamation: {
        outcome: "retained",
        error: expect.any(UnsafeManagedStackPathError),
      },
    });
    expect(readFileSync(join(outsideRoot, "preserve"), "utf8")).toBe("safe");
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
    expect(runRepo(service.repository.listCheckoutLocations())).toEqual([]);
    expect(service.inspectStack(created.stack.id)?.status).toBe("active");
    expect(readFileSync(dataFile, "utf8")).toBe("preserve me");
    await service.close();
  });

  it("persists and reuses managed state through the real Node SQLite adapter", async () => {
    const root = makeRoot();
    const stateRoot = join(root, "node-managed");
    const workspace = makeWorkspace(root, "node-workspace");
    // The Node entrypoint is exercised end to end, `node:sqlite` driver and all:
    // it is the only place the Node registry adapter and its service wiring run.
    const entrypointUrl = pathToFileURL(join(process.cwd(), "src/managed-node.ts")).href;
    const source = `
      import assert from "node:assert/strict";
      import { randomUUID } from "node:crypto";
      import { Effect } from "effect";
      import { createManagedStackService } from ${JSON.stringify(entrypointUrl)};
      const runRepo = Effect.runSync;
      const stateRoot = ${JSON.stringify(stateRoot)};
      const workspacePath = ${JSON.stringify(workspace)};
      const firstService = createManagedStackService({ stateRoot });
      assert.equal(runRepo(firstService.repository.getStack(randomUUID())), undefined);
      const first = await firstService.provisionOrdinaryStack({
        workspacePath,
        configuration: {
          ports: [{ key: "api.port", port: 55431, intent: "exact" }],
        },
      });
      const starting = await firstService.updateStack(first.stack.id, { lifecycle: "starting" });
      assert.equal(starting.ports[0]?.port, 55431);
      await firstService.updateStack(first.stack.id, { lifecycle: "stopped" });
      const abandoned = runRepo(firstService.repository.claimOperation({
        token: randomUUID(),
        stackId: first.stack.id,
        kind: "start",
        now: new Date().toISOString(),
      }));
      assert.equal(abandoned.acquired, true);
      const recovery = await firstService.reconcileAbandonedOperations({
        inspectRuntime: async () => "stopped",
      });
      assert.equal(recovery.recovered.length, 1);
      assert.equal(recovery.failures.length, 0);
      await firstService.close();
      const secondService = createManagedStackService({ stateRoot });
      const second = await secondService.provisionOrdinaryStack({ workspacePath });
      assert.equal(first.outcome, "create");
      assert.equal(second.outcome, "reuse");
      assert.equal(second.stack.id, first.stack.id);
      const conflicting = runRepo(secondService.repository.claimOperation({
        token: randomUUID(),
        stackId: second.stack.id,
        kind: "update",
        ownerPid: process.pid,
        now: new Date().toISOString(),
      }));
      assert.equal(conflicting.acquired, true);
      await assert.rejects(
        secondService.updateStack(second.stack.id, { lifecycle: "running" }),
        { name: "ManagedOperationInProgressError" },
      );
      if (!conflicting.acquired) throw new Error("Expected operation ownership");
      runRepo(secondService.repository.finishOperation(
        second.stack.id,
        conflicting.operation.token,
        "completed",
        new Date().toISOString(),
      ));
      const deleted = await secondService.deleteStack(second.stack.id);
      const repeated = await secondService.deleteStack(second.stack.id);
      assert.equal(deleted.outcome, "delete");
      assert.equal(deleted.dataReclamation.outcome, "removed");
      assert.equal(repeated.outcome, "no-op");
      await secondService.close();
    `;
    const command = [
      findNodeBinary(),
      "--no-warnings",
      "--experimental-transform-types",
      "--input-type=module",
      "--eval",
      source,
    ];
    const child = Bun.spawn(command, {
      stdout: "ignore",
      stderr: "pipe",
    });

    const exitCode = await child.exited;
    const stderr = await new Response(child.stderr).text();

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  });

  it("initializes one fresh registry safely across concurrent Bun processes", async () => {
    const root = makeRoot();
    const databasePath = managedRegistryPath(join(root, "cold"));
    const entrypointUrl = pathToFileURL(join(process.cwd(), "src/managed-bun.ts")).href;
    const source = `
      import { Context, Effect, ManagedRuntime } from "effect";
      import {
        bunSqliteManagedStackRepositoryLayer,
        ManagedStackRepository,
      } from ${JSON.stringify(entrypointUrl)};
      const layer = bunSqliteManagedStackRepositoryLayer(${JSON.stringify(databasePath)});
      const runtime = ManagedRuntime.make(layer);
      const context = Effect.runSync(runtime.contextEffect);
      Effect.runSync(Context.get(context, ManagedStackRepository).listStacks());
      await runtime.dispose();
    `;
    const children = Array.from({ length: 8 }, () =>
      Bun.spawn([process.execPath, "--eval", source], { stdout: "ignore", stderr: "pipe" }),
    );

    const results = await Promise.all(
      children.map(async (child) => ({
        exitCode: await child.exited,
        stderr: await new Response(child.stderr).text(),
      })),
    );

    expect(results).toEqual(Array.from({ length: 8 }, () => ({ exitCode: 0, stderr: "" })));
    const registry = openRegistry(databasePath);
    expect(runRepo(registry.repository.listStacks())).toEqual([]);
    await registry.close();
  });

  it("fails safely when a registry has a newer schema version", () => {
    const root = makeRoot();
    const databasePath = join(root, "future.sqlite3");
    const database = new Database(databasePath, { create: true });
    database.exec("PRAGMA user_version = 999");
    database.close();

    expect(() => openRegistry(databasePath)).toThrow(UnsupportedManagedRegistryVersionError);
  });

  it.each([1, 2])("fails clearly instead of opening obsolete development schema v%i", (version) => {
    const root = makeRoot();
    const databasePath = join(root, `obsolete-v${version}.sqlite3`);
    const database = new Database(databasePath, { create: true });
    database.exec(`PRAGMA user_version = ${version}`);
    database.close();

    expect(() => openRegistry(databasePath)).toThrow(UnsupportedManagedRegistryVersionError);
  });

  it("writes the current schema version into a fresh registry", async () => {
    const root = makeRoot();
    const databasePath = managedRegistryPath(join(root, "fresh"));
    await openRegistry(databasePath).close();

    const database = new Database(databasePath, { readonly: true });
    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: MANAGED_REGISTRY_SCHEMA_VERSION,
    });
    database.close();
    expect(databasePath.endsWith("registry-v3.sqlite3")).toBe(true);
  });
});
