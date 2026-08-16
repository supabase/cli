import { Database } from "bun:sqlite";
import { createServer, type Server } from "node:net";
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
import { Cause, Context, Effect, Exit, ManagedRuntime } from "effect";
import { managedStackContractFixtures } from "./managed-stack-contract.ts";
import { ensureOrdinaryWorkspaceIdentity } from "./managed/identity.ts";
import {
  managedRegistryPath,
  managedStackPaths,
  ordinaryWorkspaceIdentityPath,
} from "./managed/paths.ts";
import {
  ManagedCheckoutConflictError,
  DuplicateManagedPortKeyError,
  InvalidManagedIdentityError,
  InvalidManagedOwnerPidError,
  ManagedAbandonedOperationError,
  InvalidManagedPortError,
  InvalidManagedStackNameError,
  ManagedPendingStackUpdateError,
  ManagedOperationInProgressError,
  ManagedOperationOwnershipError,
  ManagedPortReservationError,
  ManagedLegacyPortConflictError,
  ManagedExactPortOccupiedError,
  ManagedStickyPortOccupiedError,
  ManagedRunningStackPortChangeError,
  ManagedRuntimeStartError,
  ManagedStackInitializationError,
  ManagedStackNotFoundError,
  ManagedStackNotStoppedError,
  ManagedStackPublicationTimeoutError,
  ManagedIdentityTransitionOwnershipError,
  UnsafeManagedStackPathError,
  type ManagedPortAssignment,
  type ManagedStackConfiguration,
  type ManagedStackProjection,
  type ManagedStackRecord,
} from "./managed/model.ts";
import type { ConfigPortKey, PortField } from "./PortCatalog.ts";
import type { ManagedPortIntentDocument } from "./managed/model.ts";
import { createInMemoryManagedStackRepository } from "./managed/repository-memory.ts";
import {
  decideManagedIdentityMetadataPrune,
  ManagedStackRepository,
  type ManagedStackRepositoryShape,
} from "./managed/repository.ts";
import { sqliteManagedStackRepositoryLayer, type ManagedSqliteDatabase } from "./managed/sqlite.ts";
import type { MakeManagedStackServiceOptions, ManagedStackServiceHandle } from "./managed-bun.ts";
import {
  bunSqliteManagedStackRepositoryLayer,
  createManagedStackService,
  makeManagedStackService,
} from "./managed-bun.ts";

/**
 * Both registry adapters decide synchronously once they are open, so a test can
 * run a contract call inline instead of awaiting it.
 */
const runRepo = Effect.runSync;

const expectFailureTag = <A, E>(exit: Exit.Exit<A, E>, tag: string): void => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.squash(exit.cause)).toMatchObject({ _tag: tag });
  }
};

/**
 * Opens a registry the way production does, as a scoped layer, for the tests that
 * exercise the SQLite adapter itself rather than a managed stack service. Opening
 * it is I/O — a cold start may wait out another process' WAL conversion — so the
 * layer is built through a Promise, and the layer's scope owns the database
 * handle until `close`.
 */
const openRegistry = async (
  databasePath: string,
): Promise<{
  readonly repository: ManagedStackRepositoryShape;
  readonly close: () => Promise<void>;
}> => {
  const runtime = ManagedRuntime.make(bunSqliteManagedStackRepositoryLayer(databasePath));
  return {
    repository: Context.get(await runtime.context(), ManagedStackRepository),
    close: () => runtime.dispose(),
  };
};

/**
 * An in-memory registry handle that runs `reenterOnce`'s callback the first time
 * a decision reads a row, so a test can re-enter the repository from inside a
 * transaction the way a mistaken caller would.
 */
const reentrantRegistry = (): {
  readonly handle: ManagedSqliteDatabase;
  readonly reenterOnce: (reentry: () => void) => void;
} => {
  const database = new Database(":memory:");
  let pending: (() => void) | undefined;
  const trigger = (): void => {
    const reentry = pending;
    pending = undefined;
    reentry?.();
  };
  return {
    reenterOnce: (reentry) => {
      pending = reentry;
    },
    handle: {
      exec(sql) {
        database.exec(sql);
      },
      prepare(sql) {
        const statement = database.query(sql);
        return {
          run(parameters = []) {
            statement.run(...parameters);
          },
          get(parameters = []) {
            trigger();
            return statement.get(...parameters) ?? undefined;
          },
          all(parameters = []) {
            trigger();
            return statement.all(...parameters);
          },
        };
      },
      close() {
        database.close();
      },
    },
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
): Promise<ManagedStackServiceHandle> =>
  makeManagedStackService({
    repository: createInMemoryManagedStackRepository(),
    stateRoot: join(root, "managed"),
    publicationPollMs: 1,
    ...overrides,
  });

const makePersistentService = (
  root: string,
  overrides: ServiceOverrides = {},
): Promise<ManagedStackServiceHandle> =>
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

const managedPortKey = (value: string): ConfigPortKey => {
  switch (value) {
    case "api.port":
    case "db.port":
    case "edge_runtime.inspector_port":
    case "local_smtp.port":
    case "local_smtp.smtp_port":
    case "local_smtp.pop3_port":
    case "studio.port":
    case "analytics.port":
    case "db.pooler.port":
      return value;
    default:
      throw new Error(`Unknown managed port key ${value}`);
  }
};

const portDocumentFromAssignments = (
  assignments: ReadonlyArray<ManagedPortAssignment>,
): {
  readonly activeFields: ReadonlyArray<PortField>;
  readonly document: Readonly<Record<string, unknown>>;
} => {
  const document = {
    api: {} as { port?: number },
    db: { port: undefined as number | undefined, pooler: {} as { port?: number } },
    edge_runtime: {} as { inspector_port?: number },
    local_smtp: {} as { port?: number; smtp_port?: number; pop3_port?: number },
    studio: {} as { port?: number },
    analytics: {} as { port?: number },
  };
  const activeFields = assignments.map((assignment) => {
    switch (assignment.key) {
      case "api.port":
        if (assignment.intent === "exact") document.api.port = assignment.port;
        return "apiPort";
      case "db.port":
        if (assignment.intent === "exact") document.db.port = assignment.port;
        return "dbPort";
      case "edge_runtime.inspector_port":
        if (assignment.intent === "exact") document.edge_runtime.inspector_port = assignment.port;
        return "edgeRuntimeInspectorPort";
      case "local_smtp.port":
        if (assignment.intent === "exact") document.local_smtp.port = assignment.port;
        return "mailpitPort";
      case "local_smtp.smtp_port":
        if (assignment.intent === "exact") document.local_smtp.smtp_port = assignment.port;
        return "mailpitSmtpPort";
      case "local_smtp.pop3_port":
        if (assignment.intent === "exact") document.local_smtp.pop3_port = assignment.port;
        return "mailpitPop3Port";
      case "studio.port":
        if (assignment.intent === "exact") document.studio.port = assignment.port;
        return "studioPort";
      case "analytics.port":
        if (assignment.intent === "exact") document.analytics.port = assignment.port;
        return "analyticsPort";
      case "db.pooler.port":
        if (assignment.intent === "exact") document.db.pooler.port = assignment.port;
        return "poolerPort";
    }
  });
  return { activeFields, document };
};

const portAssignmentFacts = (id: string) =>
  fixture(id).given.flatMap((fact) =>
    fact.kind === "port-assignment" ? [{ ...fact, key: managedPortKey(fact.key) }] : [],
  );

const requirePortFact = (id: string, key: string) => {
  const fact = portFacts(id).find((candidate) => candidate.key === key);
  if (fact === undefined || !("value" in fact) || typeof fact.value !== "number") {
    throw new Error(`Fixture ${id} does not define ${key}`);
  }
  return { key: managedPortKey(fact.key), port: fact.value, intent: fact.intent };
};

const managedPortFixtureIds = [
  "ports.exact-default-value-differs-from-omitted-default",
  "ports.env-and-remote-values-remain-exact",
  "ports.explicit-free-port-is-used",
  "ports.new-target-allocates-and-persists-omitted-ports",
  "ports.sibling-targets-allocate-independent-ports",
  "ports.sticky-ports-reuse-on-return",
  "ports.later-sticky-port-collision-fails",
  "ports.config-change-on-stopped-stack-applies",
  "ports.config-change-on-running-stack-reports-drift",
  "ports.removing-exact-key-keeps-current-port-sticky",
  "ports.running-legacy-source-fails-before-allocation",
  "ports.explicit-port-conflict-fails",
  "ports.explicit-port-conflict-with-sibling-fails",
] as const;

const portFixtureDocument = (
  id: (typeof managedPortFixtureIds)[number],
  apiPort: number,
  dbPort = apiPort + 1,
): ManagedPortIntentDocument => {
  if (id === "ports.env-and-remote-values-remain-exact") {
    return {
      activeFields: ["apiPort", "dbPort"],
      document: { api: { port: apiPort }, db: { port: dbPort } },
      valueOrigins: [
        { path: ["api", "port"], source: "environment" },
        { path: ["db", "port"], source: "remote" },
      ],
    };
  }
  if (id === "ports.exact-default-value-differs-from-omitted-default") {
    return { activeFields: ["apiPort", "dbPort"], document: { api: { port: apiPort } } };
  }
  if (
    id === "ports.new-target-allocates-and-persists-omitted-ports" ||
    id === "ports.sibling-targets-allocate-independent-ports"
  ) {
    return { activeFields: ["apiPort", "dbPort"], document: {} };
  }
  if (
    id === "ports.sticky-ports-reuse-on-return" ||
    id === "ports.later-sticky-port-collision-fails"
  ) {
    return { activeFields: ["apiPort"], document: {} };
  }
  return { activeFields: ["apiPort"], document: { api: { port: apiPort } } };
};

const holdTcpPort = async (port: number): Promise<Server> =>
  new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });

const freeTcpPort = async (): Promise<number> => {
  const server = await holdTcpPort(0);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Ephemeral port probe returned no numeric address");
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
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
    service.repository.prepareStack({
      identity,
      checkoutKind: "ordinary",
      checkoutRootPath: realpathSync(workspace),
      locationId: crypto.randomUUID(),
      context: { kind: "workspace" },
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
    const service = await makePersistentService(root);
    const stateRoot = join(root, "managed");
    const { stack } = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
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

    const service = await makePersistentService(root);
    await service.close();

    const modeOf = (path: string): number => statSync(path).mode & 0o777;
    expect(modeOf(stateRoot)).toBe(0o700);
    expect(modeOf(registryPath)).toBe(0o600);
  });

  it("keeps read-only discovery registration-free", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = await makeInMemoryService(root);

    const result = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      workspacePath: workspace,
      operation: "status",
    });

    expect(result.outcome).toBe("report");
    expect(result.state).toBe("unregistered");
    expect(result.identity).toEqual({});
    expect(result.stacks).toEqual([]);
    expect(result.workspace.checkoutKind).toBe("ordinary");
    expect(existsSync(ordinaryWorkspaceIdentityPath(workspace))).toBe(false);
    expect(runRepo(service.repository.listStacks())).toEqual([]);
    expect(runRepo(service.repository.listCheckoutLocations())).toEqual([]);
  });

  it("reports an existing identity without stacks as not yet registered", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = await makeInMemoryService(root);
    const marker = await Effect.runPromise(ensureOrdinaryWorkspaceIdentity(workspace));

    const result = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      workspacePath: workspace,
      operation: "status",
    });

    expect(result.identity).toEqual({
      projectId: marker.identity.projectId,
      checkoutId: marker.identity.checkoutId,
      contextId: marker.identity.contextId,
    });
    expect(result.state).toBe("unregistered");
    expect(result.stacks).toEqual([]);
  });

  it("uses the registry-owned workspace context when the marker context is stale", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = await makeInMemoryService(root);

    const created = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      workspacePath: workspace,
      operation: "start",
    });
    const markerPath = ordinaryWorkspaceIdentityPath(workspace);
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      version: number;
      projectId: string;
      checkoutId: string;
      contextId: string;
    };
    const staleContextId = crypto.randomUUID();
    writeFileSync(markerPath, JSON.stringify({ ...marker, contextId: staleContextId }));

    const result = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      workspacePath: workspace,
      operation: "status",
    });

    expect(result.identity).toEqual(created.identity);
    expect(result.stack?.id).toBe(created.stack.id);
    expect(result.stacks).toEqual([created.stack]);
    expect(JSON.parse(readFileSync(markerPath, "utf8"))).toEqual({
      ...marker,
      contextId: staleContextId,
    });
  });

  it("reports only the stacks of the resolved project, checkout, and context", async () => {
    const root = makeRoot();
    const repository = createInMemoryManagedStackRepository();
    let foreignContextStack: ManagedStackProjection | undefined;
    const filteringRepository: ManagedStackRepositoryShape = {
      ...repository,
      listStackProjections: (options) =>
        Effect.map(repository.listStackProjections(options), (stacks) =>
          foreignContextStack === undefined ? stacks : [...stacks, foreignContextStack],
        ),
    };
    const service = await makeManagedStackService({
      repository: filteringRepository,
      stateRoot: join(root, "managed"),
    });
    const created = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: makeWorkspace(root),
    });
    foreignContextStack = {
      ...created.stack,
      id: crypto.randomUUID(),
      contextId: crypto.randomUUID(),
    };

    const result = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      workspacePath: join(root, "workspace"),
      operation: "status",
    });

    expect(result.state).toBe("running");
    expect(result.stacks).toEqual([created.stack]);
  });

  it("fails safely on an unknown newer workspace identity marker", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = await makeInMemoryService(root);
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
      service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      }),
    ).rejects.toBeInstanceOf(InvalidManagedIdentityError);
    expect(runRepo(service.repository.listStacks())).toEqual([]);
    expect(runRepo(service.repository.listCheckoutLocations())).toEqual([]);
  });

  it.each(invalidStackNameCases)("rejects %s", async (_fixtureId, stackName) => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = await makeInMemoryService(root);

    const provision = service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: workspace,
      stackName,
    });
    await expect(provision).rejects.toBeInstanceOf(InvalidManagedStackNameError);
    await expect(provision).rejects.toThrow(`Invalid managed stack name: ${stackName}`);
    expect(existsSync(ordinaryWorkspaceIdentityPath(workspace))).toBe(false);
    expect(await service.listStacks()).toEqual([]);
  });

  it("resolves every valid fixture stack name within one ordinary context", async () => {
    const names = stackNames("identity.valid-stack-names-resolve-deterministically");
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = await makeInMemoryService(root);

    const results = await Promise.all(
      names.map((stackName) =>
        service.resolveStack({
          portDocument: { activeFields: [], document: {} },
          initialize: async () => ({ processIds: {}, containerIds: {} }),
          operation: "start",
          workspacePath: workspace,
          stackName,
        }),
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
    const service = await makePersistentService(root);

    const created = await service.resolveStack({
      portDocument: portDocumentFromAssignments([
        { key: "api.port", port: 54_321, intent: "automatic" },
      ]),
      initialize: async () => ({
        pid: process.pid,
        socketPath: join(root, "daemon.sock"),
        processIds: { postgres: process.pid },
        containerIds: { auth: "container-auth" },
      }),
      operation: "start",
      workspacePath: workspace,
      configuration: {
        runtimeRequest: "docker",
        runtime: "docker",

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
    expect(created.stack.ports).toEqual([
      expect.objectContaining({ key: "api.port", intent: "automatic", port: expect.any(Number) }),
    ]);
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
    const reopened = await makePersistentService(root);
    const reused = await reopened.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      workspacePath: workspace,
      operation: "start",
    });

    expect(reused.outcome).toBe(recoveredStart.expected.outcome);
    expect(reused.identityMarkerCreated).toBe(false);
    expect(reused.selection).toEqual(created.selection);
    expect(reused.stack.ports).toEqual(created.stack.ports);
    expect(await reopened.listStacks()).toHaveLength(1);
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
    const service = await makeManagedStackService({ repository, stateRoot });

    const result = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      workspacePath: workspace,
      operation: "start",
    });

    expect(contract.expected.outcome).toBe("create");
    expect(result.outcome).toBe("create");
    expect(service.repository).toBe(repository);
    expect(result.stack.paths.root.startsWith(stateRoot)).toBe(true);
  });

  it("publishes one stack when two callers provision the same identity concurrently", async () => {
    const contract = fixture("identity.concurrent-create-publishes-once");
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = await makePersistentService(root);
    let releaseInitialization: () => void = () => {};
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });
    let initializerCalls = 0;

    const first = service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      operation: "start",
      workspacePath: workspace,
      initialize: async () => {
        initializerCalls += 1;
        await initializationGate;
        return { processIds: {}, containerIds: {} };
      },
    });
    while (runRepo(service.repository.listStacks()).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const second = service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      workspacePath: workspace,
      operation: "start",
    });
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
    const service = await makePersistentService(root);
    let releaseInitialization: () => void = () => {};
    const initializationGate = new Promise<void>((resolve) => {
      releaseInitialization = resolve;
    });

    const first = service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      operation: "start",
      workspacePath: workspace,
      initialize: async () => {
        await initializationGate;
        return { processIds: {}, containerIds: {} };
      },
    });
    while (runRepo(service.repository.listStacks()).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const second = service.resolveStack({
      portDocument: portDocumentFromAssignments([requested]),
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: workspace,
      configuration: { serviceVersions: { postgres: "17.6.1.143" } },
    });
    releaseInitialization();
    const [created, reused] = await Promise.all([first, second]);

    expect(created.outcome).toBe("create");
    expect(reused.outcome).toBe("reuse");
    expect(reused.stack.id).toBe(created.stack.id);
    expect(reused.stack.ports).toEqual([]);
    expect(reused.stack.serviceVersions).toEqual({});
    expect(await service.inspectStack(created.stack.id)).toMatchObject({
      ports: [],
      serviceVersions: {},
    });
    await service.close();
  });

  it("rolls back failed initialization and makes the same start retryable", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = await makePersistentService(root);
    let failedRoot: string | undefined;

    await expect(
      service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        operation: "start",
        workspacePath: workspace,
        initialize: async (stack) => {
          failedRoot = stack.paths.root;
          throw new Error("initialization failed");
        },
      }),
    ).rejects.toBeInstanceOf(ManagedRuntimeStartError);

    expect(failedRoot).toBeDefined();
    expect(existsSync(failedRoot ?? "")).toBe(true);
    expect(await service.listStacks()).toEqual([
      expect.objectContaining({ lifecycle: "failed", status: "active" }),
    ]);
    expect(existsSync(ordinaryWorkspaceIdentityPath(workspace))).toBe(true);

    const retried = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      workspacePath: workspace,
      operation: "start",
    });
    expect(retried.outcome).toBe("reuse");
    expect(retried.stack.lifecycle).toBe("running");
    expect(await service.listStacks()).toHaveLength(1);
    await service.close();
  });

  it("preserves an in-flight typed failure when close races before rejection", async () => {
    const root = makeRoot();
    const base = createInMemoryManagedStackRepository();
    let signalStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const typedFailure = new InvalidManagedIdentityError({ message: "controlled failure" });
    const service = await makeManagedStackService({
      repository: {
        ...base,
        listStackProjections: () =>
          Effect.sync(() => {
            signalStarted();
            throw typedFailure;
          }),
      },
      stateRoot: join(root, "close-race-managed"),
    });
    const inFlight = service.listStacks();
    await started;
    await service.close();

    await expect(inFlight).rejects.toBe(typedFailure);
  });

  it("rejects a copied ordinary-folder identity claim", async () => {
    const root = makeRoot();
    const firstWorkspace = makeWorkspace(root, "first");
    const secondWorkspace = makeWorkspace(root, "copy");
    const service = await makePersistentService(root);
    await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: firstWorkspace,
    });
    mkdirSync(join(secondWorkspace, ".supabase"), { recursive: true });
    copyFileSync(
      ordinaryWorkspaceIdentityPath(firstWorkspace),
      ordinaryWorkspaceIdentityPath(secondWorkspace),
    );

    await expect(
      service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: secondWorkspace,
      }),
    ).rejects.toBeInstanceOf(ManagedCheckoutConflictError);
    expect(await service.listStacks()).toHaveLength(1);
    expect(runRepo(service.repository.listCheckoutLocations())).toHaveLength(1);
    await service.close();
  });

  it("times out without adopting a pending stack owned by another caller", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = await makePersistentService(root, {
      publicationTimeoutMs: 2,
      publicationPollMs: 1,
    });
    await prepareAbandonedStack(service, workspace, process.pid);

    await expect(
      service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      }),
    ).rejects.toBeInstanceOf(ManagedStackPublicationTimeoutError);
    expect(await service.listStacks()).toHaveLength(1);
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
        prepareStack: (input) =>
          Effect.map(repository.prepareStack(input), (prepared) =>
            prepared.outcome === "existing" && prepared.operation !== undefined
              ? { ...prepared, operation: { ...prepared.operation, ownerPid } }
              : prepared,
          ),
      };
      const service = await makeManagedStackService({
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
        service.resolveStack({
          portDocument: { activeFields: [], document: {} },
          initialize: async () => ({ processIds: {}, containerIds: {} }),
          workspacePath: workspace,
          operation: "start",
        }),
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
    const service = await makeManagedStackService({
      repository: observedRepository,
      stateRoot: join(root, "managed"),
      publicationTimeoutMs: 1_600,
      publicationPollMs: 400,
      isProcessAlive: () => true,
    });
    await prepareAbandonedStack(service, workspace, process.pid);

    await expect(
      service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      }),
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
    const service = await makeManagedStackService({
      repository: createInMemoryManagedStackRepository(),
      stateRoot: join(root, "managed"),
      idFactory: () => "../../outside",
    });

    await expect(
      service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      }),
    ).rejects.toBeInstanceOf(InvalidManagedIdentityError);
    expect(existsSync(join(root, "outside"))).toBe(false);
    expect(await service.listStacks()).toEqual([]);
  });
});

describe("managed port lifecycle integration", () => {
  it("passes one concrete allocation to initialization and reports intent-only running drift", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = await makeInMemoryService(root);
    let allocatedPort: number | undefined;
    const exactDocument = {
      activeFields: ["apiPort"] as const,
      document: {},
    };
    const started = await service.resolveStack({
      operation: "start",
      workspacePath: workspace,
      portDocument: exactDocument,
      initialize: async (_stack, allocation) => {
        allocatedPort = allocation.ports.apiPort;
        expect(allocation.lease.ports.apiPort).toBe(allocatedPort);
        return { processIds: {}, containerIds: {} };
      },
    });
    expect(started.stack.lifecycle).toBe("running");
    expect(allocatedPort).toBeDefined();

    const drift = await service.resolveStack({
      operation: "status",
      workspacePath: workspace,
      portDocument: {
        activeFields: ["apiPort"],
        document: { api: { port: allocatedPort } },
      },
    });
    expect(drift.portDrift).toEqual([
      {
        key: "api.port",
        actualIntent: "automatic",
        actualPort: allocatedPort,
        configuredIntent: "exact",
        configuredPort: allocatedPort,
      },
    ]);
    let runningInitializerCalls = 0;
    const beforeRunningStart = {
      stack: runRepo(service.repository.getStack(started.stack.id)),
      operations: runRepo(service.repository.listActiveOperations()),
      claims: runRepo(service.repository.listIdentityClaims()),
      locations: runRepo(service.repository.listCheckoutLocations()),
    };
    const runningStart = await service.resolveStack({
      operation: "start",
      workspacePath: workspace,
      portDocument: {
        activeFields: ["apiPort"],
        document: { api: { port: allocatedPort } },
      },
      initialize: async () => {
        runningInitializerCalls += 1;
        return { processIds: {}, containerIds: {} };
      },
    });
    expect(runningStart.outcome).toBe("reuse");
    expect(runningStart.portDrift).toEqual(drift.portDrift);
    expect(runningInitializerCalls).toBe(0);
    expect({
      stack: runRepo(service.repository.getStack(started.stack.id)),
      operations: runRepo(service.repository.listActiveOperations()),
      claims: runRepo(service.repository.listIdentityClaims()),
      locations: runRepo(service.repository.listCheckoutLocations()),
    }).toEqual(beforeRunningStart);
    expect((await service.inspectStack(started.stack.id))?.lifecycle).toBe("running");
    await service.close();
  });

  it("retains accepted durable ports when runtime initialization fails", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = await makeInMemoryService(root);
    await expect(
      service.resolveStack({
        operation: "start",
        workspacePath: workspace,
        portDocument: { activeFields: ["apiPort"], document: {} },
        initialize: async () => {
          throw new Error("runtime unavailable");
        },
      }),
    ).rejects.toBeInstanceOf(ManagedRuntimeStartError);
    const stacks = await service.listStacks();
    expect(stacks).toHaveLength(1);
    expect(stacks[0]?.lifecycle).toBe("failed");
    expect(stacks[0]?.ports).toHaveLength(1);
    await service.close();
  });

  it("rejects legacy running conflicts before workspace identity mutation", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = await makeInMemoryService(root);
    await expect(
      service.resolveStack({
        operation: "start",
        workspacePath: workspace,
        portDocument: { activeFields: ["apiPort"], document: {} },
        legacyPortConflict: { key: "api.port", port: 54321, ownerId: "legacy-project" },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
      }),
    ).rejects.toMatchObject({
      _tag: "ManagedLegacyPortConflictError",
      key: "api.port",
      port: 54321,
      ownerId: "legacy-project",
    });
    expect(await service.listStacks()).toEqual([]);
    await service.close();
  });
});

describe("managed service options", () => {
  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["tab", "\t"],
  ])(
    "refuses an %s state root instead of falling back to the working directory",
    async (_case, stateRoot) => {
      await expect(
        makeManagedStackService({
          repository: createInMemoryManagedStackRepository(),
          stateRoot,
        }),
      ).rejects.toBeInstanceOf(UnsafeManagedStackPathError);
    },
  );

  it("refuses an undefined state root before any environment fallback", async () => {
    // `stateRoot` is required in the option type, but a caller bypassing the
    // type system (or a plain-JS caller) could still pass `undefined`. That
    // must fail loudly before any environment fallback is considered.
    await expect(
      makeManagedStackService({
        repository: createInMemoryManagedStackRepository(),
        stateRoot: undefined,
      } as unknown as MakeManagedStackServiceOptions),
    ).rejects.toBeInstanceOf(UnsafeManagedStackPathError);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %s as an operation owner pid",
    async (ownerPid) => {
      const root = makeRoot();
      await expect(
        makeManagedStackService({
          repository: createInMemoryManagedStackRepository(),
          stateRoot: join(root, "managed"),
          ownerPid,
        }),
      ).rejects.toBeInstanceOf(InvalidManagedOwnerPidError);
    },
  );

  it("validates owner pids on the shared entrypoint options path too", async () => {
    const root = makeRoot();
    await expect(
      createManagedStackService({
        repository: createInMemoryManagedStackRepository(),
        stateRoot: join(root, "managed"),
        ownerPid: 0,
      }),
    ).rejects.toBeInstanceOf(InvalidManagedOwnerPidError);

    const service = await createManagedStackService({
      repository: createInMemoryManagedStackRepository(),
      stateRoot: join(root, "managed"),
      ownerPid: 4321,
    });
    expect(service.stateRoot).toBe(join(root, "managed"));
    await service.close();
  });

  it("awaits an initialize callback that answers with a thenable rather than a Promise", async () => {
    // A caller whose promises come from another implementation — a bundled
    // polyfill, a Bluebird-style library — answers with a thenable that is not
    // `instanceof Promise`. Publishing on such an answer would mean publishing a
    // stack whose initialization has not run yet.
    const root = makeRoot();
    const service = await makePersistentService(root);
    let initialized = false;
    // Answering `then` through a proxy rather than declaring the property: the
    // lint rule that guards against accidental thenables forbids writing one,
    // and being a thenable on purpose is this fixture's whole point.
    const thenable = new Proxy(
      {},
      {
        get: (_target, property) =>
          property === "then"
            ? (resolve: (value: undefined) => void) => {
                setTimeout(() => {
                  initialized = true;
                  resolve(undefined);
                }, 5);
              }
            : undefined,
      },
    ) as unknown as Promise<{ processIds: {}; containerIds: {} }>;

    const created = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      operation: "start",
      workspacePath: makeWorkspace(root),
      initialize: () => thenable,
    });

    expect(initialized).toBe(true);
    expect(created.stack.status).toBe("active");
    await service.close();
  });

  it("rejects a call made after close with an error that says the handle is closed", async () => {
    // A caller that reaches for a closed handle — a stray promise, a shutdown
    // race — must get a diagnosable rejection rather than the runtime's bare
    // internal string, which has neither a name nor a stack.
    const root = makeRoot();
    const service = await makePersistentService(root);
    await service.close();

    await expect(service.listStacks()).rejects.toBeInstanceOf(Error);
    await expect(service.listStacks()).rejects.toThrow(/closed/i);
  });

  it("reports a callback's own rejection as itself even when it mentions disposal", async () => {
    // Whether the handle is closed is the handle's own state, never something
    // read back out of what a rejection happens to say: a caller's callback that
    // refuses with a string mentioning disposal must reach that caller unchanged.
    const root = makeRoot();
    const service = await makePersistentService(root);
    const { stack } = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: makeWorkspace(root),
    });
    await service.updateStack(stack.id, { lifecycle: "running" });

    let rejection: unknown;
    try {
      await service.deleteStack(stack.id, {
        stop: () => Promise.reject("the container was disposed"),
      });
    } catch (error: unknown) {
      rejection = error;
    }

    expect(String(rejection)).toContain("the container was disposed");
    expect(String(rejection)).not.toContain("handle is closed");
    expect(await service.inspectStack(stack.id)).toMatchObject({ status: "active" });
    await service.close();
  });

  it("closes a service acquired with await using when its block ends", async () => {
    const root = makeRoot();
    let acquired: ManagedStackServiceHandle | undefined;
    {
      await using service = await makePersistentService(root);
      acquired = service;
      const created = await service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root),
      });
      expect(await service.inspectStack(created.stack.id)).toMatchObject({ status: "active" });
    }

    if (acquired === undefined) {
      throw new Error("Expected the disposed handle to be captured");
    }
    // Leaving the block disposed the runtime that owns the registry, so the
    // repository the service handed out is closed along with it.
    const disposed = acquired;
    expect(() => runRepo(disposed.repository.listStacks())).toThrow();

    const reopened = await makePersistentService(root);
    expect(await reopened.listStacks()).toHaveLength(1);
    await reopened.close();
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
          ? await makeInMemoryService(root, overrides)
          : await makePersistentService(root, overrides);
      const first = await service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "Projects"),
      });
      const second = await service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "apps"),
      });

      expect(first.stack.createdAt).toBe(second.stack.createdAt);
      expect(second.stack.id < first.stack.id).toBe(true);
      expect((await service.listStacks()).map((stack) => stack.id)).toEqual(
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
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);

      const created = await service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      });
      const reused = await service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      });

      expect(contract.expected.outcome).toBe("report");
      expect(created.outcome).toBe("create");
      expect(reused.outcome).toBe("reuse");
      expect(reused.selection).toEqual(created.selection);
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`scopes stack projections and preserves ordering and tombstones with the ${adapter} adapter`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory"
          ? await makeInMemoryService(root, {
              clock: () => new Date("2026-08-11T00:00:00.000Z"),
              idFactory: descendingIdFactory(),
            })
          : await makePersistentService(root, {
              clock: () => new Date("2026-08-11T00:00:00.000Z"),
              idFactory: descendingIdFactory(),
            });
      const workspace = makeWorkspace(root, "scoped");
      const first = await service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: workspace,
        stackName: "first",
      });
      const second = await service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: workspace,
        stackName: "second",
      });
      await service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "foreign"),
      });
      await service.updateStack(first.stack.id, { lifecycle: "stopped" });
      await service.deleteStack(first.stack.id);

      const identity = {
        projectId: first.identity.projectId,
        checkoutId: first.identity.checkoutId,
        contextId: first.identity.contextId,
      };
      const live = runRepo(service.repository.listStackProjections({ identity }));
      expect(live.map((stack) => stack.id)).toEqual([second.stack.id]);

      const withTombstones = runRepo(
        service.repository.listStackProjections({
          identity,
          includeTombstoned: true,
        }),
      );
      expect(withTombstones.map((stack) => stack.id)).toEqual(
        [first.stack.id, second.stack.id].sort(),
      );
      await service.close();
    });
  }

  it("anchors an injected relative state root so a later chdir cannot split stack state", async () => {
    const service = await makeManagedStackService({
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
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);
      const workspace = makeWorkspace(root);

      await expect(
        service.resolveStack({
          portDocument: portDocumentFromAssignments([
            { key: "api.port", port: 54_321.5, intent: "exact" },
          ]),
          initialize: async () => ({ processIds: {}, containerIds: {} }),
          operation: "start",
          workspacePath: workspace,
          configuration: {},
        }),
      ).rejects.toBeInstanceOf(InvalidManagedPortError);

      const created = await service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      });
      await expect(
        service.updateStack(created.stack.id, {
          ports: [{ key: "api.port", port: 70_000, intent: "exact" }],
        }),
      ).rejects.toBeInstanceOf(InvalidManagedPortError);
      expect((await service.inspectStack(created.stack.id))?.ports).toEqual([]);
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`rejects duplicate port keys with a coded failure for the ${adapter} adapter`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);
      const workspace = makeWorkspace(root);
      const duplicateKeyPorts: Array<ManagedPortAssignment> = [
        { key: "api.port", port: 54_401, intent: "automatic" as const },
        { key: "api.port", port: 54_402, intent: "automatic" as const },
      ];

      const provisionFailure = await service
        .resolveStack({
          portDocument: portDocumentFromAssignments(duplicateKeyPorts),
          initialize: async () => ({ processIds: {}, containerIds: {} }),
          operation: "start",
          workspacePath: workspace,
          configuration: {},
        })
        .catch((error: unknown) => error);
      expect(provisionFailure).toBeInstanceOf(DuplicateManagedPortKeyError);
      expect((provisionFailure as DuplicateManagedPortKeyError).code).toBe(
        "MANAGED_DUPLICATE_PORT_KEY",
      );

      const created = await service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        workspacePath: workspace,
        operation: "start",
      });
      const updateFailure = await service
        .updateStack(created.stack.id, { ports: duplicateKeyPorts })
        .catch((error: unknown) => error);
      expect(updateFailure).toBeInstanceOf(DuplicateManagedPortKeyError);
      expect((updateFailure as DuplicateManagedPortKeyError).code).toBe(
        "MANAGED_DUPLICATE_PORT_KEY",
      );
      expect((await service.inspectStack(created.stack.id))?.ports).toEqual([]);
      await service.close();
    });
  }

  it("persists stack configuration and reserves ports globally", async () => {
    const root = makeRoot();
    const service = await makePersistentService(root);
    const first = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: makeWorkspace(root, "first"),
    });
    const second = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: makeWorkspace(root, "second"),
    });
    await service.updateStack(first.stack.id, { lifecycle: "stopped" });

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
    ).rejects.toBeInstanceOf(ManagedRunningStackPortChangeError);
    expect((await service.inspectStack(second.stack.id))?.ports).toEqual([]);
    await service.close();
  });

  it("rolls back an in-memory registration when its initial port reservation conflicts", async () => {
    const root = makeRoot();
    const service = await makeInMemoryService(root);
    await service.resolveStack({
      portDocument: portDocumentFromAssignments([
        { key: "api.port", port: 54_321, intent: "exact" },
      ]),
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: makeWorkspace(root, "first"),
      configuration: {
        lifecycle: "running",
      },
    });
    const secondWorkspace = makeWorkspace(root, "second");

    await expect(
      service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 54_321, intent: "exact" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: secondWorkspace,
        configuration: {
          lifecycle: "starting",
        },
      }),
    ).rejects.toBeInstanceOf(ManagedExactPortOccupiedError);
    expect(runRepo(service.repository.listCheckoutLocations())).toHaveLength(2);
    expect(await service.listStacks()).toHaveLength(1);

    const retried = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: secondWorkspace,
    });
    expect(retried.outcome).toBe("create");
    expect(runRepo(service.repository.listCheckoutLocations())).toHaveLength(2);
  });

  it("requires actual runtime inspection before recovering an abandoned operation", async () => {
    const root = makeRoot();
    const service = await makeInMemoryService(root, { isProcessAlive: () => false });
    const created = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: makeWorkspace(root),
    });
    await service.updateStack(created.stack.id, { lifecycle: "stopped" });
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
    expect((await service.inspectStack(created.stack.id))?.lifecycle).toBe("starting");

    const reconciled = await service.reconcileAbandonedOperations({
      inspectRuntime: async () => "stopped",
    });
    expect(reconciled.retained).toEqual([]);
    expect(reconciled.abortedStackIds).toEqual([]);
    expect(reconciled.recovered).toHaveLength(1);
    expect((await service.inspectStack(created.stack.id))?.lifecycle).toBe("stopped");
  });

  it("aborts a crashed pending provision and makes the identity retryable", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = await makePersistentService(root, {
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
    expect(await service.listStacks()).toEqual([]);

    const retried = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      workspacePath: workspace,
      operation: "start",
    });
    expect(retried.outcome).toBe("create");
    expect(retried.stack.id).not.toBe(pending.stack.id);
    await service.close();
  });

  it("publishes a crashed pending provision when runtime inspection finds it running", async () => {
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const service = await makePersistentService(root, {
      isProcessAlive: () => false,
    });
    const pending = await prepareAbandonedStack(service, workspace, 987_651);

    const reconciled = await service.reconcileAbandonedOperations({
      inspectRuntime: async () => "running",
    });

    expect(reconciled.abortedStackIds).toEqual([]);
    expect(reconciled.recovered).toHaveLength(1);
    expect(reconciled.recovered[0]).toMatchObject({ status: "active", lifecycle: "running" });
    const reused = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      workspacePath: workspace,
      operation: "start",
    });
    expect(reused.outcome).toBe("reuse");
    expect(reused.stack.id).toBe(pending.stack.id);
    await service.close();
  });

  it("retains operations while their owner process is still alive", async () => {
    const root = makeRoot();
    const service = await makeInMemoryService(root, {
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
    expect((await service.inspectStack(pending.stack.id))?.status).toBe("pending");
  });

  it("force-recovers an operation when a stale or reused PID still appears alive", async () => {
    const root = makeRoot();
    const service = await makeInMemoryService(root, { isProcessAlive: () => true });
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
    expect(await service.listStacks()).toEqual([]);
  });

  it.each([
    ["stack ID", { stackId: "not-a-uuid", operationToken: crypto.randomUUID() }],
    ["operation token", { stackId: crypto.randomUUID(), operationToken: "not-a-uuid" }],
  ])("rejects a forced recovery with an invalid %s", async (_label, force) => {
    const root = makeRoot();
    const service = await makeInMemoryService(root);
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
    const service = await makeInMemoryService(root, { isProcessAlive: () => true });
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
    expect((await service.listStacks()).map(({ id }) => id).sort()).toEqual(
      pending
        .filter(({ stack }) => stack.id !== target.stack.id)
        .map(({ stack }) => stack.id)
        .sort(),
    );
  });

  it("reconciles repository operations that have no owner PID", async () => {
    const root = makeRoot();
    const service = await makeInMemoryService(root, { isProcessAlive: () => true });
    const pending = await prepareAbandonedStack(service, makeWorkspace(root));

    const reconciled = await service.reconcileAbandonedOperations({
      inspectRuntime: async () => "stopped",
    });

    expect(reconciled.abortedStackIds).toEqual([pending.stack.id]);
    expect(reconciled.retained).toEqual([]);
  });

  it("does not reclaim data when another recovery pass adopts the pending stack", async () => {
    const root = makeRoot();
    const service = await makePersistentService(root, { isProcessAlive: () => false });
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
    expect(await service.inspectStack(pending.stack.id)).toMatchObject({
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
          ? await makeInMemoryService(root, { isProcessAlive: () => false })
          : await makePersistentService(root, { isProcessAlive: () => false });
      let stackRoot: string | undefined;
      let dataFile: string | undefined;

      await expect(
        service.resolveStack({
          portDocument: { activeFields: [], document: {} },
          operation: "start",
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
            return { processIds: {}, containerIds: {} };
          },
        }),
      ).rejects.toBeInstanceOf(ManagedStackInitializationError);

      expect(stackRoot).toBeDefined();
      expect(dataFile).toBeDefined();
      expect(existsSync(stackRoot ?? "")).toBe(true);
      expect(readFileSync(dataFile ?? "", "utf8")).toBe("live data");
      expect(await service.listStacks()).toEqual([
        expect.objectContaining({ status: "active", lifecycle: "running" }),
      ]);
      await service.close();
    });
  }

  it("retains an operation when owner liveness cannot be determined", async () => {
    const root = makeRoot();
    const livenessError = new Error("liveness unavailable");
    const service = await makeInMemoryService(root, {
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
    const service = await makeInMemoryService(root, { isProcessAlive: () => false });
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
    const service = await makeManagedStackService({
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
    expect(await service.listStacks()).toEqual([]);
  });

  it("continues recovery when an owner finishes one operation during inspection", async () => {
    const root = makeRoot();
    const service = await makeInMemoryService(root, { isProcessAlive: () => false });
    const first = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: makeWorkspace(root, "first"),
    });
    const second = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
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
          ? await makeInMemoryService(root, overrides)
          : await makePersistentService(root, overrides);
      const owner = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_409, intent: "exact" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "owner"),
        configuration: {
          lifecycle: "running",
        },
      });
      await expect(
        prepareAbandonedStack(service, makeWorkspace(root, "pending"), 987_673, {
          ports: [{ key: "api.port", port: 55_409, intent: "exact" }],
        }),
      ).rejects.toBeInstanceOf(ManagedPortReservationError);
      expect((await service.inspectStack(owner.stack.id))?.ports).toEqual([
        { key: "api.port", port: 55_409, intent: "exact" },
      ]);
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`releases a failed runtime adoption operation with ${adapter}`, async () => {
      const root = makeRoot();
      const overrides = { isProcessAlive: () => false };
      const service =
        adapter === "in-memory"
          ? await makeInMemoryService(root, overrides)
          : await makePersistentService(root, overrides);
      await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_410, intent: "exact" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "owner"),
        configuration: {
          lifecycle: "running",
        },
      });
      await expect(
        service.resolveStack({
          portDocument: portDocumentFromAssignments([
            { key: "api.port", port: 55_410, intent: "exact" },
          ]),
          initialize: async () => ({ processIds: {}, containerIds: {} }),
          operation: "start",
          workspacePath: makeWorkspace(root, "blocked"),
          configuration: {},
        }),
      ).rejects.toBeInstanceOf(ManagedExactPortOccupiedError);
      expect(await service.listStacks()).toHaveLength(1);
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
    const service = await makePersistentService(root);
    const initial = await service.resolveStack({
      portDocument: portDocumentFromAssignments([
        { key: previous.key, port: previous.port, intent: previous.intent },
      ]),
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: makeWorkspace(root),
      configuration: {},
    });
    await service.updateStack(initial.stack.id, { lifecycle: "stopped" });

    const changed = await service.resolveStack({
      portDocument: portDocumentFromAssignments([requested]),
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: join(root, "workspace"),
      configuration: {},
    });
    expect(changed.outcome).toBe("reuse");
    expect(changed.stack.ports).toEqual([requested]);
    await service.updateStack(changed.stack.id, { lifecycle: "stopped" });

    const removed = portFacts(removedFixtureId).find((fact) => fact.key === "api.port");
    if (removed === undefined) {
      throw new Error(`Fixture ${removedFixtureId} has no api.port intent`);
    }
    const sticky = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: join(root, "workspace"),
      configuration: {},
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
    const service = await makePersistentService(root);
    const created = await service.resolveStack({
      portDocument: portDocumentFromAssignments([
        { key: previous.key, port: previous.port, intent: previous.intent },
      ]),
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: makeWorkspace(root),
      configuration: {
        lifecycle: "running",
      },
    });

    await expect(
      service.updateStack(created.stack.id, { ports: [requested] }),
    ).rejects.toBeInstanceOf(ManagedRunningStackPortChangeError);
    expect((await service.inspectStack(created.stack.id))?.ports).toEqual([
      { key: previous.key, port: previous.port, intent: previous.intent },
    ]);
    await service.close();
  });

  const runManagedPortFixture = async (
    adapter: "in-memory" | "bun-sqlite",
    fixtureId: (typeof managedPortFixtureIds)[number],
  ): Promise<void> => {
    const root = makeRoot();
    const service =
      adapter === "in-memory" ? await makeInMemoryService(root) : await makePersistentService(root);
    const apiPort = await freeTcpPort();
    const dbPort =
      fixtureId === "ports.env-and-remote-values-remain-exact" ? await freeTcpPort() : apiPort + 1;
    const workspace = makeWorkspace(root, "workspace");
    const initialize = async () => ({ processIds: {}, containerIds: {} });
    const document = portFixtureDocument(fixtureId, apiPort, dbPort);
    try {
      if (fixtureId === "ports.running-legacy-source-fails-before-allocation") {
        await expect(
          service.resolveStack({
            workspacePath: workspace,
            operation: "start",
            portDocument: document,
            initialize,
            legacyPortConflict: { key: "api.port", port: apiPort, ownerId: "legacy" },
          }),
        ).rejects.toBeInstanceOf(ManagedLegacyPortConflictError);
        expect(await service.listStacks()).toEqual([]);
        return;
      }

      if (fixtureId === "ports.explicit-port-conflict-fails") {
        const held = await holdTcpPort(apiPort);
        try {
          await expect(
            service.resolveStack({
              workspacePath: workspace,
              operation: "start",
              portDocument: document,
              initialize,
            }),
          ).rejects.toBeInstanceOf(ManagedExactPortOccupiedError);
          expect(await service.listStacks()).toEqual([]);
        } finally {
          await new Promise<void>((resolve) => held.close(() => resolve()));
        }
        return;
      }

      if (fixtureId === "ports.explicit-port-conflict-with-sibling-fails") {
        await service.resolveStack({
          workspacePath: workspace,
          operation: "start",
          portDocument: document,
          initialize,
        });
        await expect(
          service.resolveStack({
            workspacePath: makeWorkspace(root, "sibling"),
            operation: "start",
            portDocument: document,
            initialize,
          }),
        ).rejects.toBeInstanceOf(ManagedExactPortOccupiedError);
        expect(await service.listStacks()).toHaveLength(1);
        return;
      }

      if (fixtureId === "ports.later-sticky-port-collision-fails") {
        const created = await service.resolveStack({
          workspacePath: workspace,
          operation: "start",
          portDocument: document,
          initialize,
        });
        const stickyPort = created.stack.ports[0]?.port;
        if (stickyPort === undefined) throw new Error("Automatic fixture did not persist a port");
        await service.updateStack(created.stack.id, { lifecycle: "stopped" });
        const held = await holdTcpPort(stickyPort);
        try {
          await expect(
            service.resolveStack({
              workspacePath: workspace,
              operation: "start",
              portDocument: document,
              initialize,
            }),
          ).rejects.toBeInstanceOf(ManagedStickyPortOccupiedError);
        } finally {
          await new Promise<void>((resolve) => held.close(() => resolve()));
        }
        return;
      }

      if (fixtureId === "ports.config-change-on-running-stack-reports-drift") {
        const created = await service.resolveStack({
          workspacePath: workspace,
          operation: "start",
          portDocument: portFixtureDocument(fixtureId, apiPort),
          initialize,
        });
        const before = {
          stack: await service.inspectStack(created.stack.id),
          operations: runRepo(service.repository.listActiveOperations()),
          claims: runRepo(service.repository.listIdentityClaims()),
        };
        let initialized = 0;
        const changedPort = await freeTcpPort();
        const resolved = await service.resolveStack({
          workspacePath: workspace,
          operation: "start",
          portDocument: portFixtureDocument(fixtureId, changedPort),
          initialize: async () => {
            initialized += 1;
            return initialize();
          },
        });
        expect(resolved.outcome).toBe("reuse");
        expect(resolved.portDrift).toEqual([
          expect.objectContaining({
            key: "api.port",
            actualPort: apiPort,
            configuredPort: changedPort,
          }),
        ]);
        expect(initialized).toBe(0);
        expect(await service.inspectStack(created.stack.id)).toEqual(before.stack);
        expect(runRepo(service.repository.listActiveOperations())).toEqual(before.operations);
        expect(runRepo(service.repository.listIdentityClaims())).toEqual(before.claims);
        return;
      }

      if (fixtureId === "ports.config-change-on-stopped-stack-applies") {
        const first = await service.resolveStack({
          workspacePath: workspace,
          operation: "start",
          portDocument: portFixtureDocument(fixtureId, apiPort),
          initialize,
        });
        await service.updateStack(first.stack.id, { lifecycle: "stopped" });
        const changedPort = await freeTcpPort();
        const changed = await service.resolveStack({
          workspacePath: workspace,
          operation: "start",
          portDocument: portFixtureDocument(fixtureId, changedPort),
          initialize,
        });
        expect(changed.stack.ports).toEqual([
          { key: "api.port", port: changedPort, intent: "exact" },
        ]);
        return;
      }

      if (fixtureId === "ports.removing-exact-key-keeps-current-port-sticky") {
        const first = await service.resolveStack({
          workspacePath: workspace,
          operation: "start",
          portDocument: document,
          initialize,
        });
        await service.updateStack(first.stack.id, { lifecycle: "stopped" });
        const removed = await service.resolveStack({
          workspacePath: workspace,
          operation: "start",
          portDocument: { activeFields: [], document: {} },
          initialize,
        });
        expect(removed.stack.ports).toEqual([
          { key: "api.port", port: apiPort, intent: "automatic" },
        ]);
        return;
      }

      const started = await service.resolveStack({
        workspacePath: workspace,
        operation: "start",
        portDocument: document,
        initialize,
      });
      expect(started.state).toBe("running");
      expect(started.stack.lifecycle).toBe("running");
      expect(started.stack.ports.length).toBeGreaterThan(0);
      if (fixtureId === "ports.exact-default-value-differs-from-omitted-default") {
        expect(started.stack.ports).toEqual([
          { key: "api.port", port: apiPort, intent: "exact" },
          expect.objectContaining({ key: "db.port", intent: "automatic" }),
        ]);
      }
      if (fixtureId === "ports.env-and-remote-values-remain-exact") {
        expect(started.stack.ports).toEqual([
          { key: "api.port", port: apiPort, intent: "exact" },
          { key: "db.port", port: dbPort, intent: "exact" },
        ]);
      }
      if (
        fixtureId === "ports.new-target-allocates-and-persists-omitted-ports" ||
        fixtureId === "ports.sibling-targets-allocate-independent-ports" ||
        fixtureId === "ports.sticky-ports-reuse-on-return"
      ) {
        expect(started.stack.ports.every((assignment) => assignment.intent === "automatic")).toBe(
          true,
        );
      }
      if (fixtureId === "ports.sticky-ports-reuse-on-return") {
        const stickyPort = started.stack.ports[0]?.port;
        await service.updateStack(started.stack.id, { lifecycle: "stopped" });
        const returned = await service.resolveStack({
          workspacePath: workspace,
          operation: "start",
          portDocument: document,
          initialize,
        });
        expect(returned.stack.ports[0]?.port).toBe(stickyPort);
      }
      if (fixtureId === "ports.sibling-targets-allocate-independent-ports") {
        const sibling = await service.resolveStack({
          workspacePath: makeWorkspace(root, "sibling"),
          operation: "start",
          portDocument: document,
          initialize,
        });
        expect(sibling.stack.ports[0]?.port).not.toBe(started.stack.ports[0]?.port);
      }
      if (fixtureId === "ports.new-target-allocates-and-persists-omitted-ports") {
        const failed = await service
          .resolveStack({
            workspacePath: makeWorkspace(root, "failed-runtime"),
            operation: "start",
            portDocument: document,
            initialize: async () => {
              throw new ManagedRuntimeStartError({ cause: "fixture runtime failure" });
            },
          })
          .catch((error: unknown) => error);
        expect(failed).toBeInstanceOf(ManagedRuntimeStartError);
        const failedStack = (await service.listStacks()).find(
          (stack) => stack.lifecycle === "failed",
        );
        expect(failedStack?.ports.length).toBe(2);
      }
    } finally {
      await service.close();
    }
  };

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    for (const fixtureId of managedPortFixtureIds) {
      it(
        `${fixtureId} through ${adapter}`,
        () => runManagedPortFixture(adapter, fixtureId),
        15_000,
      );
    }
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`allows failed-stack recovery and intent-only updates with ${adapter}`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);
      const failed = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_401, intent: "exact" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "failed"),
        configuration: {
          lifecycle: "failed",
        },
      });
      await service.updateStack(failed.stack.id, { lifecycle: "failed" });

      const restarted = await service.updateStack(failed.stack.id, {
        lifecycle: "starting",
        ports: [{ key: "api.port", port: 55_402, intent: "exact" }],
      });
      expect(restarted).toMatchObject({
        lifecycle: "starting",
        ports: [{ key: "api.port", port: 55_402, intent: "exact" }],
      });

      const running = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_403, intent: "exact" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "running"),
        configuration: {
          lifecycle: "running",
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

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`applies the intent-sensitive managed reservation matrix with ${adapter}`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);
      const first = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_501, intent: "exact" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "first"),
        configuration: {},
      });
      const second = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_502, intent: "exact" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "second"),
        configuration: {},
      });

      expect(
        runRepo(service.repository.listPortReservations()).filter(
          (reservation) => reservation.assignment.port === 55_501,
        ),
      ).toHaveLength(1);

      await service.updateStack(first.stack.id, {
        lifecycle: "running",
      });
      await service.updateStack(second.stack.id, { lifecycle: "starting" });
      expect((await service.inspectStack(first.stack.id))?.ports).toEqual([
        { key: "api.port", port: 55_501, intent: "exact" },
      ]);
      expect((await service.inspectStack(second.stack.id))?.ports).toEqual([
        { key: "api.port", port: 55_502, intent: "exact" },
      ]);
      await service.updateStack(first.stack.id, { lifecycle: "stopped" });
      const unchanged = await service.updateStack(second.stack.id, {
        ports: [{ key: "api.port", port: 55_501, intent: "automatic" }],
      });
      expect(unchanged.ports).toEqual([{ key: "api.port", port: 55_502, intent: "automatic" }]);
      expect((await service.inspectStack(first.stack.id))?.ports).toEqual([
        { key: "api.port", port: 55_501, intent: "exact" },
      ]);
      expect((await service.inspectStack(second.stack.id))?.ports).toEqual([
        { key: "api.port", port: 55_502, intent: "automatic" },
      ]);
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`claims a complete starting assignment atomically with ${adapter}`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);
      const owner = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_507, intent: "exact" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "owner"),
        configuration: {
          lifecycle: "running",
        },
      });
      const pending = await prepareAbandonedStack(
        service,
        makeWorkspace(root, "pending"),
        process.pid,
        { ports: [{ key: "api.port", port: 55_508, intent: "exact" }] },
      );

      await expect(
        Effect.runPromise(
          service.repository.claimStartPorts({
            stackId: pending.stack.id,
            operationToken: pending.operation.token,
            ports: [{ key: "api.port", port: 55_507, intent: "exact" }],
            now: "2026-08-16T00:00:01.000Z",
          }),
        ),
      ).rejects.toBeInstanceOf(ManagedPortReservationError);
      expect((await service.inspectStack(owner.stack.id))?.ports).toEqual([
        { key: "api.port", port: 55_507, intent: "exact" },
      ]);
      expect((await service.inspectStack(pending.stack.id))?.ports).toEqual([
        { key: "api.port", port: 55_508, intent: "exact" },
      ]);
      expect((await service.inspectStack(pending.stack.id))?.lifecycle).toBe("stopped");

      const claimed = await Effect.runPromise(
        service.repository.claimStartPorts({
          stackId: pending.stack.id,
          operationToken: pending.operation.token,
          ports: [{ key: "api.port", port: 55_508, intent: "exact" }],
          now: "2026-08-16T00:00:02.000Z",
        }),
      );
      expect(claimed.lifecycle).toBe("starting");
      expect(claimed.ports).toEqual([{ key: "api.port", port: 55_508, intent: "exact" }]);
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`claimStartPorts accepts stopped stacks with ${adapter}`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);
      const stopped = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_509, intent: "exact" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "stopped"),
        configuration: {},
      });
      await service.updateStack(stopped.stack.id, { lifecycle: "stopped" });
      const operation = runRepo(
        service.repository.claimOperation({
          token: crypto.randomUUID(),
          stackId: stopped.stack.id,
          kind: "start",
          ownerPid: process.pid,
          now: "2026-08-16T00:01:00.000Z",
        }),
      );
      if (!operation.acquired) throw new Error("Expected a start operation claim");

      const claimed = await Effect.runPromise(
        service.repository.claimStartPorts({
          stackId: stopped.stack.id,
          operationToken: operation.operation.token,
          ports: [{ key: "api.port", port: 55_510, intent: "exact" }],
          now: "2026-08-16T00:01:01.000Z",
        }),
      );
      expect(claimed.lifecycle).toBe("starting");
      expect(claimed.ports).toEqual([{ key: "api.port", port: 55_510, intent: "exact" }]);
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`claimStartPorts accepts failed stacks with ${adapter}`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);
      const failed = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_511, intent: "exact" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "failed"),
        configuration: {
          lifecycle: "failed",
        },
      });
      await service.updateStack(failed.stack.id, { lifecycle: "failed" });
      const operation = runRepo(
        service.repository.claimOperation({
          token: crypto.randomUUID(),
          stackId: failed.stack.id,
          kind: "start",
          ownerPid: process.pid,
          now: "2026-08-16T00:02:00.000Z",
        }),
      );
      if (!operation.acquired) throw new Error("Expected a start operation claim");

      const claimed = await Effect.runPromise(
        service.repository.claimStartPorts({
          stackId: failed.stack.id,
          operationToken: operation.operation.token,
          ports: [{ key: "api.port", port: 55_512, intent: "exact" }],
          now: "2026-08-16T00:02:01.000Z",
        }),
      );
      expect(claimed.lifecycle).toBe("starting");
      expect(claimed.ports).toEqual([{ key: "api.port", port: 55_512, intent: "exact" }]);
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`claimStartPorts rejects a missing active operation without mutation with ${adapter}`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);
      const stopped = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_513, intent: "exact" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "missing-operation"),
        configuration: {},
      });
      await service.updateStack(stopped.stack.id, { lifecycle: "stopped" });

      await expect(
        Effect.runPromise(
          service.repository.claimStartPorts({
            stackId: stopped.stack.id,
            operationToken: crypto.randomUUID(),
            ports: [{ key: "api.port", port: 55_514, intent: "exact" }],
            now: "2026-08-16T00:03:00.000Z",
          }),
        ),
      ).rejects.toBeInstanceOf(ManagedOperationOwnershipError);
      expect((await service.inspectStack(stopped.stack.id))?.lifecycle).toBe("stopped");
      expect((await service.inspectStack(stopped.stack.id))?.ports).toEqual([
        { key: "api.port", port: 55_513, intent: "exact" },
      ]);
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`claimStartPorts rejects a wrong active operation without mutation with ${adapter}`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);
      const stopped = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_515, intent: "exact" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "wrong-operation"),
        configuration: {},
      });
      await service.updateStack(stopped.stack.id, { lifecycle: "stopped" });
      const operation = runRepo(
        service.repository.claimOperation({
          token: crypto.randomUUID(),
          stackId: stopped.stack.id,
          kind: "start",
          ownerPid: process.pid,
          now: "2026-08-16T00:04:00.000Z",
        }),
      );
      if (!operation.acquired) throw new Error("Expected a start operation claim");

      await expect(
        Effect.runPromise(
          service.repository.claimStartPorts({
            stackId: stopped.stack.id,
            operationToken: crypto.randomUUID(),
            ports: [{ key: "api.port", port: 55_516, intent: "exact" }],
            now: "2026-08-16T00:04:01.000Z",
          }),
        ),
      ).rejects.toBeInstanceOf(ManagedOperationOwnershipError);
      expect((await service.inspectStack(stopped.stack.id))?.lifecycle).toBe("stopped");
      expect((await service.inspectStack(stopped.stack.id))?.ports).toEqual([
        { key: "api.port", port: 55_515, intent: "exact" },
      ]);
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`claimStartPorts blocks a direct automatic claim against a stopped automatic reservation with ${adapter}`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);
      const owner = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_517, intent: "automatic" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "automatic-owner"),
        configuration: {},
      });
      const target = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_518, intent: "exact" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "automatic-target"),
        configuration: {},
      });
      await service.updateStack(owner.stack.id, { lifecycle: "stopped" });
      await service.updateStack(owner.stack.id, {
        ports: [{ key: "api.port", port: 55_517, intent: "exact" }],
      });
      await service.updateStack(owner.stack.id, {
        ports: [{ key: "api.port", port: 55_517, intent: "automatic" }],
      });
      await service.updateStack(target.stack.id, { lifecycle: "stopped" });
      const operation = runRepo(
        service.repository.claimOperation({
          token: crypto.randomUUID(),
          stackId: target.stack.id,
          kind: "start",
          ownerPid: process.pid,
          now: "2026-08-16T00:05:00.000Z",
        }),
      );
      if (!operation.acquired) throw new Error("Expected a start operation claim");

      await expect(
        Effect.runPromise(
          service.repository.claimStartPorts({
            stackId: target.stack.id,
            operationToken: operation.operation.token,
            ports: [{ key: "api.port", port: 55_517, intent: "automatic" }],
            now: "2026-08-16T00:05:01.000Z",
          }),
        ),
      ).rejects.toBeInstanceOf(ManagedPortReservationError);
      expect((await service.inspectStack(owner.stack.id))?.ports).toEqual([
        { key: "api.port", port: 55_517, intent: "automatic" },
      ]);
      expect((await service.inspectStack(target.stack.id))?.lifecycle).toBe("stopped");
      expect((await service.inspectStack(target.stack.id))?.ports).toEqual([
        { key: "api.port", port: 55_518, intent: "exact" },
      ]);
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`blocks stopped automatic and preserves rejected writes with ${adapter}`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);
      const automatic = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_502, intent: "automatic" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "automatic"),
        configuration: {},
      });
      const exact = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_503, intent: "exact" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "exact"),
        configuration: {},
      });
      await service.updateStack(automatic.stack.id, { lifecycle: "stopped" });
      await service.updateStack(automatic.stack.id, {
        ports: [{ key: "api.port", port: 55_502, intent: "exact" }],
      });
      await service.updateStack(automatic.stack.id, {
        ports: [{ key: "api.port", port: 55_502, intent: "automatic" }],
      });
      await service.updateStack(exact.stack.id, { lifecycle: "stopped" });

      const automaticAgain = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_502, intent: "automatic" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "automatic-again"),
      });
      expect(automaticAgain.outcome).toBe("create");

      await expect(
        service.updateStack(exact.stack.id, {
          ports: [{ key: "api.port", port: 55_502, intent: "exact" }],
        }),
      ).rejects.toBeInstanceOf(ManagedPortReservationError);
      expect((await service.inspectStack(automatic.stack.id))?.ports).toEqual([
        { key: "api.port", port: 55_502, intent: "automatic" },
      ]);
      expect((await service.inspectStack(exact.stack.id))?.ports).toEqual([
        { key: "api.port", port: 55_503, intent: "exact" },
      ]);
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`keeps failed automatic rows exclusive while failed exact rows coexist with ${adapter}`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);
      const failedAutomatic = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_504, intent: "automatic" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "failed-automatic"),
        configuration: {
          lifecycle: "failed",
        },
      });
      await service.updateStack(failedAutomatic.stack.id, { lifecycle: "failed" });
      await service.updateStack(failedAutomatic.stack.id, {
        lifecycle: "failed",
        ports: [{ key: "api.port", port: 55_504, intent: "exact" }],
      });
      await service.updateStack(failedAutomatic.stack.id, {
        ports: [{ key: "api.port", port: 55_504, intent: "automatic" }],
      });
      const failedExact = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_505, intent: "exact" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "failed-exact"),
        configuration: {
          lifecycle: "failed",
        },
      });
      await service.updateStack(failedExact.stack.id, { lifecycle: "failed" });
      const failedExactSibling = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_505, intent: "exact" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "failed-exact-sibling"),
        configuration: {
          lifecycle: "failed",
        },
      });
      await service.updateStack(failedExactSibling.stack.id, { lifecycle: "failed" });

      await expect(
        service.updateStack(failedExact.stack.id, {
          ports: [{ key: "api.port", port: 55_504, intent: "exact" }],
        }),
      ).rejects.toBeInstanceOf(ManagedPortReservationError);
      expect((await service.inspectStack(failedAutomatic.stack.id))?.ports).toEqual([
        { key: "api.port", port: 55_504, intent: "automatic" },
      ]);
      expect((await service.inspectStack(failedExact.stack.id))?.ports).toEqual([
        { key: "api.port", port: 55_505, intent: "exact" },
      ]);
      expect((await service.inspectStack(failedExactSibling.stack.id))?.ports).toEqual([
        { key: "api.port", port: 55_505, intent: "exact" },
      ]);
      await service.close();
    });
  }

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`removes tombstoned rows from managed reservations with ${adapter}`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);
      const created = await service.resolveStack({
        portDocument: portDocumentFromAssignments([
          { key: "api.port", port: 55_506, intent: "exact" },
        ]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root),
        configuration: {},
      });
      expect(
        runRepo(service.repository.listPortReservations()).map(
          (reservation) => reservation.stackId,
        ),
      ).toContain(created.stack.id);

      await service.updateStack(created.stack.id, { lifecycle: "stopped" });
      await service.deleteStack(created.stack.id);
      expect(
        runRepo(service.repository.listPortReservations()).map(
          (reservation) => reservation.stackId,
        ),
      ).not.toContain(created.stack.id);
      await service.close();
    });
  }

  it("reports duplicate ports inside one stack as a managed reservation error", async () => {
    const root = makeRoot();
    const service = await makePersistentService(root);
    const created = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
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
    expect((await service.inspectStack(created.stack.id))?.ports).toEqual([]);
    await service.close();
  });

  it("rejects a second operation claim without mutating the stack", async () => {
    const root = makeRoot();
    const service = await makeInMemoryService(root);
    const created = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: makeWorkspace(root),
    });
    await service.updateStack(created.stack.id, { lifecycle: "stopped" });
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
    expect((await service.inspectStack(created.stack.id))?.lifecycle).toBe("stopped");
  });

  for (const adapter of ["in-memory", "bun-sqlite"] as const) {
    it(`reports missing stacks and operation ownership mismatches with ${adapter}`, async () => {
      const root = makeRoot();
      const service =
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);

      await expect(
        service.updateStack(crypto.randomUUID(), { lifecycle: "stopped" }),
      ).rejects.toBeInstanceOf(ManagedStackNotFoundError);

      const created = await service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
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
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);
      const deleted = await service.resolveStack({
        portDocument: portDocumentFromAssignments([reserved]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "deleted"),
        configuration: { lifecycle: "running" },
      });
      await service.deleteStack(deleted.stack.id, { stop: async () => {} });

      await expect(
        service.updateStack(deleted.stack.id, { lifecycle: "running", ports: [reserved] }),
      ).rejects.toBeInstanceOf(ManagedStackNotFoundError);

      expect(await service.inspectStack(deleted.stack.id)).toMatchObject({
        status: "tombstoned",
        lifecycle: "stopped",
        ports: [],
      });
      expect(runRepo(service.repository.listActiveOperations())).toEqual([]);

      const successor = await service.resolveStack({
        portDocument: portDocumentFromAssignments([reserved]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root, "successor"),
        configuration: { lifecycle: "running" },
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
            ? await makeInMemoryService(root, overrides)
            : await makePersistentService(root, overrides);
        const created = await service.resolveStack({
          portDocument: { activeFields: [], document: {} },
          initialize: async () => ({ processIds: {}, containerIds: {} }),
          operation: "start",
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
        expect(await service.inspectStack(created.stack.id)).toMatchObject({
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
        expect((await service.inspectStack(created.stack.id))?.status).toBe("tombstoned");
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
          ? await makeInMemoryService(root, overrides)
          : await makePersistentService(root, overrides);
      const created = await service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
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
      expect((await service.inspectStack(created.stack.id))?.status).toBe("tombstoned");
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
        adapter === "in-memory" ? undefined : await openRegistry(managedRegistryPath(stateRoot));
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
      const service = await makeManagedStackService({
        repository: guardedRepository,
        stateRoot,
        isProcessAlive: () => false,
      });
      const created = await service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
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
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);
      const studio = { key: "studio.port", port: 55_501, intent: "exact" } as const;
      const api = { key: "api.port", port: 55_502, intent: "exact" } as const;
      const db = { key: "db.port", port: 55_503, intent: "exact" } as const;
      const sorted = [api, db, studio];

      const created = await service.resolveStack({
        portDocument: portDocumentFromAssignments([studio, api, db]),
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root),
        configuration: {},
      });

      expect(created.stack.ports).toEqual(sorted);
      expect((await service.inspectStack(created.stack.id))?.ports).toEqual(sorted);

      const updated = await service.updateStack(created.stack.id, { ports: [db, studio, api] });

      expect(updated.ports).toEqual(sorted);
      expect((await service.inspectStack(created.stack.id))?.ports).toEqual(sorted);
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
          ? await makeInMemoryService(root, overrides)
          : await makePersistentService(root, overrides);
      const nextToken = descendingIdFactory();
      const tokens: Array<string> = [];
      for (const name of ["first", "second", "third"]) {
        const created = await service.resolveStack({
          portDocument: { activeFields: [], document: {} },
          initialize: async () => ({ processIds: {}, containerIds: {} }),
          operation: "start",
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
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);
      const created = await service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
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
      expect(await service.listStacks()).toHaveLength(1);
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
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);
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

      expect(await service.inspectStack(pending.stack.id)).toMatchObject({
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
        adapter === "in-memory"
          ? await makeInMemoryService(root)
          : await makePersistentService(root);
      const created = await service.resolveStack({
        portDocument: { activeFields: [], document: {} },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath: makeWorkspace(root),
        configuration: { lifecycle: "running" },
      });

      await expect(service.deleteStack(created.stack.id)).rejects.toBeInstanceOf(
        ManagedStackNotStoppedError,
      );

      expect(await service.inspectStack(created.stack.id)).toMatchObject({
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
    const service = await makeManagedStackService({
      repository: racingRepository,
      stateRoot: join(root, "managed"),
    });
    const created = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: makeWorkspace(root),
    });
    let stoppedLifecycle: string | undefined;

    await service.deleteStack(created.stack.id, {
      stop: async (stack) => {
        stoppedLifecycle = stack.lifecycle;
      },
    });

    expect(stoppedLifecycle).toBe("running");
    expect((await service.inspectStack(created.stack.id))?.status).toBe("tombstoned");
  });

  it("treats a delete as successful when a concurrent forced recovery already resolved its operation", async () => {
    // Data removal already happened by the time this call closes out the
    // operation, so a concurrent forced recovery racing to resolve the same
    // claim first must not turn an already-completed delete into a failure.
    const root = makeRoot();
    const repository = createInMemoryManagedStackRepository();
    const racingRepository: ManagedStackRepositoryShape = {
      ...repository,
      finishOperation: (stackId, operationToken, outcome, now, error) => {
        const operation = runRepo(repository.listActiveOperations()).find(
          (candidate) => candidate.token === operationToken,
        );
        return operation?.kind === "delete" && outcome === "completed"
          ? Effect.fail(new ManagedOperationOwnershipError({ stackId }))
          : repository.finishOperation(stackId, operationToken, outcome, now, error);
      },
    };
    const service = await makeManagedStackService({
      repository: racingRepository,
      stateRoot: join(root, "managed"),
    });
    const created = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: makeWorkspace(root),
    });

    const deleted = await service.deleteStack(created.stack.id, { stop: async () => {} });

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
    const service = await makePersistentService(root);
    const created = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
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
    expect(await service.listStacks()).toEqual([]);
    expect(await service.listStacks({ includeTombstoned: true })).toHaveLength(1);
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
    const service = await makeManagedStackService({
      repository: guardedRepository,
      stateRoot: join(root, "managed"),
    });
    const created = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: makeWorkspace(root),
    });
    await service.deleteStack(created.stack.id, { stop: async () => {} });
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
    const service = await makePersistentService(root);
    const created = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: makeWorkspace(root),
    });
    const dataFile = join(created.stack.paths.data, "database");
    writeFileSync(dataFile, "preserve me");

    const locations = runRepo(service.repository.listCheckoutLocations());
    const pruned = await service.prune({ recordIds: locations.map((location) => location.id) });

    expect(contract.expected.outcome).toBe("update");
    expect(pruned.removed).toBe(0);
    expect(pruned.preservedRecordIds).toEqual(locations.map((location) => location.id));
    expect(runRepo(service.repository.listCheckoutLocations())).toHaveLength(1);
    expect((await service.inspectStack(created.stack.id))?.status).toBe("active");
    expect(readFileSync(dataFile, "utf8")).toBe("preserve me");
    await service.close();
  });

  it("accepts an explicit discovery prune operation and validates its record IDs", async () => {
    const root = makeRoot();
    const service = await makePersistentService(root);
    const created = await service.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }),
      operation: "start",
      workspacePath: makeWorkspace(root),
    });
    const locationsBefore = runRepo(service.repository.listCheckoutLocations());
    const current = locationsBefore[0];
    if (current === undefined) throw new Error("expected a registered checkout location");
    runRepo(
      service.repository.applyCheckoutLocation({
        checkoutId: current.checkoutId,
        locationId: "superseded-location",
        canonicalPath: join(root, "moved-checkout"),
        now: "2026-08-13T00:01:00.000Z",
      }),
    );

    const pruned = await service.prune({
      operation: "prune",
      recordIds: [current.id],
    });

    expect(pruned).toMatchObject({
      removed: 0,
      prunedRecordIds: [],
      preservedRecordIds: [current.id],
    });
    expect((await service.inspectStack(created.stack.id))?.status).toBe("active");
    await expect(service.prune({ recordIds: [" "] })).rejects.toBeInstanceOf(
      InvalidManagedIdentityError,
    );
    await expect(service.prune({ recordIds: [current.id, current.id] })).rejects.toBeInstanceOf(
      InvalidManagedIdentityError,
    );
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
      const firstService = await createManagedStackService({ stateRoot });
      assert.equal(runRepo(firstService.repository.getStack(randomUUID())), undefined);
      const first = await firstService.resolveStack({
        portDocument: { activeFields: ["apiPort"], document: { api: { port: 55431 } } },
        initialize: async () => ({ processIds: {}, containerIds: {} }),
        operation: "start",
        workspacePath,
        configuration: {},
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
      const secondService = await createManagedStackService({ stateRoot });
      const second = await secondService.resolveStack({
      portDocument: { activeFields: [], document: {} },
      initialize: async () => ({ processIds: {}, containerIds: {} }), workspacePath, operation: "start" });
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
      await secondService.updateStack(second.stack.id, { lifecycle: "stopped" });
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
      const context = await runtime.context();
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
    const registry = await openRegistry(databasePath);
    expect(runRepo(registry.repository.listStacks())).toEqual([]);
    await registry.close();
  });

  it("keeps registry transactions atomic while concurrent fibers share one handle", async () => {
    // A registry decision is a transaction on a single connection, so its
    // `BEGIN`, statements, and `COMMIT` must run without a suspension point
    // between them: a fiber parked mid-transaction would let another fiber's
    // `BEGIN IMMEDIATE` nest on the same handle, and either fiber's `COMMIT`
    // could then publish the other's writes. Each fiber runs far more
    // sequential decisions than the scheduler's operation budget, so it is
    // preempted many times over the course of the pass.
    const root = makeRoot();
    const registry = await openRegistry(managedRegistryPath(join(root, "concurrent")));
    const rounds = Array.from({ length: 2_000 }, (_, index) => index);
    const hammerRegistry = Effect.forEach(
      rounds,
      () =>
        // A read transaction and a write transaction, so neither boundary is
        // covered by the other's locking.
        Effect.flatMap(registry.repository.listStacks(), () =>
          registry.repository.pruneIdentityMetadata({ locationIds: [] }),
        ),
      { discard: true },
    );

    const exit = await Effect.runPromiseExit(
      Effect.all([hammerRegistry, hammerRegistry, hammerRegistry, hammerRegistry], {
        concurrency: "unbounded",
      }),
    );

    expect(Exit.isSuccess(exit) ? "committed" : Cause.pretty(exit.cause)).toBe("committed");
    await registry.close();
  });

  it("refuses a registry decision that re-enters the repository, keeping its own writes", async () => {
    // SQLite has no nested transactions, so a decision that calls back into the
    // repository can only lose: the inner `BEGIN` is refused, and unwinding the
    // inner attempt would roll back the writes the outer decision has already
    // made. The guard therefore refuses before any statement runs.
    const root = makeRoot();
    const workspace = makeWorkspace(root);
    const identity = (await Effect.runPromise(ensureOrdinaryWorkspaceIdentity(workspace))).identity;
    const sqlite = reentrantRegistry();
    const runtime = ManagedRuntime.make(sqliteManagedStackRepositoryLayer(() => sqlite.handle));
    const repository = Context.get(await runtime.context(), ManagedStackRepository);

    let nested: Exit.Exit<ReadonlyArray<ManagedStackRecord>> | undefined;
    sqlite.reenterOnce(() => {
      nested = Effect.runSyncExit(repository.listStacks());
    });

    const stackId = crypto.randomUUID();
    const prepared = runRepo(
      repository.prepareStack({
        identity,
        checkoutKind: "ordinary",
        checkoutRootPath: realpathSync(workspace),
        locationId: crypto.randomUUID(),
        context: { kind: "workspace" },
        stackId,
        stackName: "default",
        paths: managedStackPaths(join(root, "managed"), stackId),
        operationToken: crypto.randomUUID(),
        now: "2026-08-11T00:00:00.000Z",
        configuration: {},
      }),
    );

    if (nested === undefined || !Exit.isFailure(nested)) {
      throw new Error("Expected the nested decision to be refused");
    }
    expect(Cause.pretty(nested.cause)).toContain("A registry transaction is already open");
    expect(prepared.outcome).toBe("create");
    // The refusal never touched the transaction in flight, so the outer
    // decision committed and the handle is free for the next one.
    expect(runRepo(repository.listStacks()).map((stack) => stack.id)).toEqual([stackId]);
    await runtime.dispose();
  });

  it("creates and reopens the current registry without mutating SQLite user_version", async () => {
    const root = makeRoot();
    const databasePath = managedRegistryPath(join(root, "fresh"));
    const first = await openRegistry(databasePath);
    expect(runRepo(first.repository.listStacks())).toEqual([]);
    await first.close();

    const database = new Database(databasePath, { readonly: true });
    expect(database.query("PRAGMA user_version").get()).toEqual({
      user_version: 0,
    });
    database.close();
    const second = await openRegistry(databasePath);
    expect(runRepo(second.repository.listStacks())).toEqual([]);
    await second.close();
    expect(databasePath.endsWith("registry.sqlite3")).toBe(true);
  });

  it("refuses a registry whose expected table is missing a load-bearing column", async () => {
    const root = makeRoot();
    const databasePath = managedRegistryPath(join(root, "missing-column"));
    const registry = await openRegistry(databasePath);
    await registry.close();

    const database = new Database(databasePath);
    database.exec("ALTER TABLE contexts RENAME COLUMN owner_branch TO owner_branch_missing");
    database.close();

    await expect(openRegistry(databasePath)).rejects.toMatchObject({
      _tag: "IncompatibleManagedRegistryError",
      code: "INCOMPATIBLE_MANAGED_REGISTRY",
      reason: "table contexts is missing column owner_branch",
    });
  });

  it("reports a partially created registry as an incompatible schema", async () => {
    const root = makeRoot();
    const stateRoot = join(root, "partial-schema");
    mkdirSync(stateRoot, { recursive: true });
    const databasePath = managedRegistryPath(stateRoot);
    const database = new Database(databasePath);
    database.exec("CREATE TABLE projects (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
    database.close();

    await expect(openRegistry(databasePath)).rejects.toMatchObject({
      _tag: "IncompatibleManagedRegistryError",
      code: "INCOMPATIBLE_MANAGED_REGISTRY",
      reason: "Managed registry schema is incomplete",
    });
  });

  it("refuses a registry whose active-location index has the wrong columns", async () => {
    const root = makeRoot();
    const databasePath = managedRegistryPath(join(root, "wrong-index-columns"));
    const registry = await openRegistry(databasePath);
    await registry.close();

    const database = new Database(databasePath);
    database.exec(`
      DROP INDEX one_active_location_per_path;
      CREATE UNIQUE INDEX one_active_location_per_path
        ON checkout_locations(checkout_id) WHERE state = 'active';
    `);
    database.close();

    await expect(openRegistry(databasePath)).rejects.toThrow(
      "index one_active_location_per_path has columns",
    );
  });

  it("refuses a registry whose active-location index lost its partial predicate", async () => {
    const root = makeRoot();
    const databasePath = managedRegistryPath(join(root, "missing-index-predicate"));
    const registry = await openRegistry(databasePath);
    await registry.close();

    const database = new Database(databasePath);
    database.exec(`
      DROP INDEX one_active_location_per_path;
      CREATE UNIQUE INDEX one_active_location_per_path
        ON checkout_locations(canonical_path);
    `);
    database.close();

    await expect(openRegistry(databasePath)).rejects.toThrow(
      "index one_active_location_per_path is missing its partial predicate",
    );
  });

  describe("managed identity repository decisions", () => {
    const adapters = async () => {
      const root = makeRoot();
      const sqlite = await openRegistry(managedRegistryPath(join(root, "identity")));
      return [
        {
          name: "memory",
          repository: createInMemoryManagedStackRepository(),
          close: async () => {},
        },
        { name: "sqlite", repository: sqlite.repository, close: sqlite.close },
      ] as const;
    };

    const location = (checkoutId: string, locationId: string, canonicalPath: string) => ({
      checkoutId,
      locationId,
      canonicalPath,
      now: "2026-08-13T00:00:00.000Z",
    });

    const seedCheckout = (
      repository: ManagedStackRepositoryShape,
      adapterName: string,
      keep = false,
      checkoutId = "checkout-a",
      checkoutPath = "/a",
      locationId = checkoutId === "checkout-a" ? "loc-a" : "loc-b",
    ) => {
      const stackId = `00000000-0000-7000-8000-00000000010${adapterName === "memory" ? "1" : "2"}`;
      const operationToken = `00000000-0000-7000-8000-00000000011${adapterName === "memory" ? "1" : "2"}`;
      const identity = {
        projectId: `project-${adapterName}`,
        checkoutId,
        contextId: `00000000-0000-7000-8000-0000000001${adapterName === "memory" ? "1" : "2"}${checkoutId === "checkout-a" ? "1" : "2"}`,
      };
      const prepared = runRepo(
        repository.prepareStack({
          identity,
          checkoutKind: "ordinary",
          checkoutRootPath: checkoutPath,
          locationId,
          context: { kind: "workspace" },
          stackId,
          stackName: "seed",
          paths: managedStackPaths(`/tmp/${adapterName}-state`, stackId),
          operationToken,
          now: "2026-08-13T00:00:00.000Z",
          configuration: {},
        }),
      );
      if (prepared.outcome === "create" && !keep)
        runRepo(repository.abortPendingStack(stackId, operationToken));
      return prepared;
    };

    it.each(["rebind", "one-active", "blocked", "prune", "owner", "transition", "competing"])(
      "%s decisions have parity across adapters",
      async (caseName) => {
        const cases = await adapters();
        try {
          for (const adapter of cases) {
            if (caseName === "rebind") {
              const prepared = seedCheckout(adapter.repository, adapter.name, true);
              runRepo(
                adapter.repository.applyCheckoutLocation(location("checkout-a", "loc-a", "/a")),
              );
              const decision = runRepo(
                adapter.repository.applyCheckoutLocation(location("checkout-a", "loc-b", "/b")),
              );
              expect(decision.outcome, adapter.name).toBe("rebound");
              expect(runRepo(adapter.repository.listIdentityClaims()).locations).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ id: "loc-a", state: "superseded" }),
                  expect.objectContaining({
                    id: "loc-b",
                    state: "active",
                    reboundFromLocationId: "loc-a",
                  }),
                ]),
              );
              if (prepared.outcome === "create") {
                expect(
                  runRepo(adapter.repository.getStackProjection(prepared.stack.id)),
                ).toMatchObject({
                  canonicalPath: "/b",
                });
              }
            }

            if (caseName === "one-active") {
              seedCheckout(adapter.repository, adapter.name);
              runRepo(
                adapter.repository.applyCheckoutLocation(location("checkout-a", "loc-a", "/a")),
              );
              runRepo(
                adapter.repository.applyCheckoutLocation(location("checkout-a", "loc-b", "/b")),
              );
              expect(
                runRepo(adapter.repository.listIdentityClaims()).locations.filter(
                  (candidate) =>
                    candidate.checkoutId === "checkout-a" && candidate.state === "active",
                ),
              ).toHaveLength(1);
            }

            if (caseName === "blocked") {
              seedCheckout(adapter.repository, adapter.name);
              runRepo(
                adapter.repository.applyCheckoutLocation(location("checkout-a", "loc-a", "/a")),
              );
              runRepo(
                adapter.repository.applyCheckoutLocation(location("checkout-a", "loc-b", "/b")),
              );
              const decision = runRepo(
                adapter.repository.applyCheckoutLocation(location("checkout-a", "loc-a", "/a")),
              );
              expect(decision.outcome, adapter.name).toBe("blocked");
              expect(runRepo(adapter.repository.listIdentityClaims()).locations).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ id: "loc-a", state: "blocked" }),
                  expect.objectContaining({ id: "loc-b", state: "blocked" }),
                ]),
              );
            }

            if (caseName === "prune") {
              seedCheckout(adapter.repository, adapter.name);
              runRepo(
                adapter.repository.applyCheckoutLocation(location("checkout-a", "loc-a", "/a")),
              );
              runRepo(
                adapter.repository.applyCheckoutLocation(location("checkout-a", "loc-b", "/b")),
              );
              const result = runRepo(
                adapter.repository.pruneIdentityMetadata({ locationIds: ["loc-a", "loc-b"] }),
              );
              expect(result.removed, adapter.name).toBe(0);
              expect(result.preservedRecordIds, adapter.name).toEqual(["loc-a", "loc-b"]);
            }

            if (caseName === "owner") {
              const identity = {
                projectId: `project-${adapter.name}`,
                checkoutId: `checkout-${adapter.name}`,
                contextId: `context-${adapter.name}`,
              };
              const prepared = runRepo(
                adapter.repository.prepareStack({
                  identity,
                  checkoutKind: "ordinary",
                  checkoutRootPath: `/tmp/${adapter.name}`,
                  locationId: "owner-location",
                  context: { kind: "branch", locator: "display-main" },
                  stackId: `00000000-0000-7000-8000-00000000000${adapter.name === "memory" ? "1" : "2"}`,
                  stackName: "default",
                  paths: managedStackPaths(
                    `/tmp/${adapter.name}-state`,
                    `00000000-0000-7000-8000-00000000000${adapter.name === "memory" ? "1" : "2"}`,
                  ),
                  operationToken: `00000000-0000-7000-8000-00000000001${adapter.name === "memory" ? "1" : "2"}`,
                  now: "2026-08-13T00:00:00.000Z",
                  configuration: {},
                }),
              );
              const refreshed = runRepo(
                adapter.repository.refreshContextOwner({
                  contextId: prepared.stack.contextId,
                  ownerBranch: "owner-main",
                  locator: "display-renamed",
                  now: "2026-08-13T00:01:00.000Z",
                }),
              );
              expect(refreshed, adapter.name).toMatchObject({
                ownerBranch: "owner-main",
                locator: "display-renamed",
              });
            }

            if (caseName === "transition" || caseName === "competing") {
              const input = {
                id: "transition-a",
                kind: "rebind-checkout" as const,
                checkoutId: "checkout-a",
                path: "/a",
                now: "2026-08-13T00:00:00.000Z",
              };
              const first = runRepo(adapter.repository.reserveIdentityTransition(input));
              const repeated = runRepo(adapter.repository.reserveIdentityTransition(input));
              expect(repeated, adapter.name).toEqual(first);
              if (caseName === "competing") {
                expect(() =>
                  runRepo(
                    adapter.repository.reserveIdentityTransition({
                      ...input,
                      id: "transition-b",
                    }),
                  ),
                ).toThrow(ManagedIdentityTransitionOwnershipError);
              }
            }
          }
        } finally {
          await Promise.all(cases.map((adapter) => adapter.close()));
        }
      },
    );

    it("rejects location ownership collisions and unknown checkouts in both adapters", async () => {
      const cases = await adapters();
      try {
        for (const adapter of cases) {
          const unknownCheckoutBefore = runRepo(adapter.repository.listIdentityClaims());
          const unknownCheckoutExit = Effect.runSyncExit(
            adapter.repository.applyCheckoutLocation(
              location("missing", "loc-missing", "/missing"),
            ),
          );
          expectFailureTag(unknownCheckoutExit, "ManagedCheckoutConflictError");
          expect(runRepo(adapter.repository.listIdentityClaims())).toEqual(unknownCheckoutBefore);
          seedCheckout(adapter.repository, adapter.name);
          runRepo(adapter.repository.applyCheckoutLocation(location("checkout-a", "loc-a", "/a")));
          seedCheckout(adapter.repository, adapter.name, false, "checkout-b", "/b");
          const before = runRepo(adapter.repository.listIdentityClaims());
          const collisionExit = Effect.runSyncExit(
            adapter.repository.applyCheckoutLocation(location("checkout-b", "loc-a", "/other")),
          );
          expectFailureTag(collisionExit, "ManagedCheckoutConflictError");
          expect(runRepo(adapter.repository.listIdentityClaims())).toEqual(before);
        }
      } finally {
        await Promise.all(cases.map((adapter) => adapter.close()));
      }
    });

    it("registers an identity without creating a stack or operation in both adapters", async () => {
      const cases = await adapters();
      try {
        for (const adapter of cases) {
          const registered = runRepo(
            adapter.repository.registerCheckoutIdentity({
              identity: {
                projectId: `identity-project-${adapter.name}`,
                checkoutId: `identity-checkout-${adapter.name}`,
                contextId: `identity-context-${adapter.name}`,
              },
              checkoutKind: "ordinary",
              checkoutRootPath: `/identity/${adapter.name}`,
              locationId: `identity-location-${adapter.name}`,
              context: { kind: "workspace" },
              now: "2026-08-13T00:00:00.000Z",
            }),
          );
          expect(registered.identity).toEqual({
            projectId: `identity-project-${adapter.name}`,
            checkoutId: `identity-checkout-${adapter.name}`,
            contextId: `identity-context-${adapter.name}`,
          });
          expect(registered.contextId).toBe(`identity-context-${adapter.name}`);
          expect(registered.location).toMatchObject({
            checkoutId: `identity-checkout-${adapter.name}`,
            canonicalPath: `/identity/${adapter.name}`,
            state: "active",
          });
          expect(registered.context).toMatchObject({
            id: `identity-context-${adapter.name}`,
            kind: "workspace",
          });
          expect(runRepo(adapter.repository.listStacks())).toEqual([]);
          expect(runRepo(adapter.repository.listActiveOperations())).toEqual([]);
          const repeated = runRepo(
            adapter.repository.registerCheckoutIdentity({
              identity: {
                projectId: `identity-project-${adapter.name}`,
                checkoutId: `identity-checkout-${adapter.name}`,
                contextId: `identity-context-${adapter.name}-new`,
              },
              checkoutKind: "ordinary",
              checkoutRootPath: `/identity/${adapter.name}`,
              locationId: `identity-location-${adapter.name}-new`,
              context: { kind: "workspace" },
              now: "2026-08-13T00:01:00.000Z",
            }),
          );
          expect(repeated.identity).toEqual(registered.identity);
          expect(repeated.contextId).toBe(registered.contextId);
          expect(repeated.location.id).toBe(registered.location.id);
          const beforeCollision = runRepo(adapter.repository.listIdentityClaims());
          const collision = Effect.runSyncExit(
            adapter.repository.registerCheckoutIdentity({
              identity: {
                projectId: `identity-project-${adapter.name}-other`,
                checkoutId: `identity-checkout-${adapter.name}-other`,
                contextId: `identity-context-${adapter.name}-other`,
              },
              checkoutKind: "ordinary",
              checkoutRootPath: `/identity/${adapter.name}`,
              locationId: `identity-location-${adapter.name}-other`,
              context: { kind: "workspace" },
              now: "2026-08-13T00:02:00.000Z",
            }),
          );
          expectFailureTag(collision, "ManagedCheckoutConflictError");
          expect(runRepo(adapter.repository.listIdentityClaims())).toEqual(beforeCollision);
        }
      } finally {
        await Promise.all(cases.map((adapter) => adapter.close()));
      }
    });

    it("migrates a workspace context to one branch context without changing its stack identity", async () => {
      const cases = await adapters();
      try {
        for (const adapter of cases) {
          const prepared = seedCheckout(adapter.repository, adapter.name, true);
          if (prepared.outcome !== "create") throw new Error("Expected seeded stack");
          const contextId = prepared.stack.contextId;
          const before = {
            claims: runRepo(adapter.repository.listIdentityClaims()),
            stacks: runRepo(adapter.repository.listStacks({ includeTombstoned: true })),
            operations: runRepo(adapter.repository.listActiveOperations()),
          };
          const input = {
            contextId,
            projectId: `project-${adapter.name}`,
            checkoutId: "checkout-a",
            branch: "main",
            now: "2026-08-13T00:05:00.000Z",
          };
          const migrated = runRepo(adapter.repository.migrateContextToBranch(input));
          expect(migrated).toMatchObject({
            id: contextId,
            projectId: input.projectId,
            checkoutId: undefined,
            kind: "branch",
            locator: "main",
            ownerBranch: "main",
          });
          expect(migrated.createdAt).toBe(
            before.claims.contexts.find((context) => context.id === contextId)?.createdAt,
          );
          expect(runRepo(adapter.repository.getStack(prepared.stack.id))).toMatchObject({
            id: prepared.stack.id,
            contextId,
            checkoutId: "checkout-a",
          });
          expect(runRepo(adapter.repository.listIdentityClaims())).toMatchObject({
            locations: before.claims.locations,
            transitions: before.claims.transitions,
          });

          const repeated = runRepo(adapter.repository.migrateContextToBranch(input));
          expect(repeated).toEqual(migrated);
          expect(runRepo(adapter.repository.listActiveOperations())).toEqual(before.operations);
        }
      } finally {
        await Promise.all(cases.map((adapter) => adapter.close()));
      }
    });

    it("refuses ownership migration mismatches and copied branches without writes in both adapters", async () => {
      const cases = await adapters();
      try {
        for (const adapter of cases) {
          const prepared = seedCheckout(adapter.repository, adapter.name);
          if (prepared.outcome !== "create") throw new Error("Expected seeded stack");
          const contextId = prepared.stack.contextId;
          const input = {
            contextId,
            projectId: `project-${adapter.name}`,
            checkoutId: "checkout-a",
            branch: "main",
            now: "2026-08-13T00:05:00.000Z",
          };
          const expectUnchangedFailure = (
            migration: Parameters<ManagedStackRepositoryShape["migrateContextToBranch"]>[0],
            tag: string,
          ): void => {
            const before = {
              claims: runRepo(adapter.repository.listIdentityClaims()),
              stacks: runRepo(adapter.repository.listStacks({ includeTombstoned: true })),
              operations: runRepo(adapter.repository.listActiveOperations()),
            };
            expectFailureTag(
              Effect.runSyncExit(adapter.repository.migrateContextToBranch(migration)),
              tag,
            );
            expect(runRepo(adapter.repository.listIdentityClaims())).toEqual(before.claims);
            expect(runRepo(adapter.repository.listStacks({ includeTombstoned: true }))).toEqual(
              before.stacks,
            );
            expect(runRepo(adapter.repository.listActiveOperations())).toEqual(before.operations);
          };

          expectUnchangedFailure(
            { ...input, checkoutId: "wrong-checkout" },
            "DuplicateManagedIdentityError",
          );
          expectUnchangedFailure(
            { ...input, projectId: "wrong-project" },
            "DuplicateManagedIdentityError",
          );
          runRepo(adapter.repository.migrateContextToBranch(input));
          expectUnchangedFailure(
            { ...input, branch: "develop" },
            "ManagedCopiedBranchConflictError",
          );

          const second = seedCheckout(
            adapter.repository,
            adapter.name,
            false,
            "checkout-b",
            "/b",
            "loc-b",
          );
          if (second.outcome !== "create") throw new Error("Expected second seeded stack");
          expectUnchangedFailure(
            {
              ...input,
              contextId: second.stack.contextId,
              checkoutId: "checkout-b",
            },
            "ManagedCopiedBranchConflictError",
          );

          const detached = runRepo(
            adapter.repository.prepareStack({
              identity: {
                projectId: input.projectId,
                checkoutId: "checkout-detached",
                contextId: `detached-context-${adapter.name}`,
              },
              checkoutKind: "ordinary",
              checkoutRootPath: `/detached/${adapter.name}`,
              locationId: `detached-location-${adapter.name}`,
              context: { kind: "detached" },
              stackId: `00000000-0000-7000-8000-00000000030${adapter.name === "memory" ? "1" : "2"}`,
              stackName: "detached",
              paths: managedStackPaths(
                `/tmp/${adapter.name}-state`,
                `00000000-0000-7000-8000-00000000030${adapter.name === "memory" ? "1" : "2"}`,
              ),
              operationToken: `00000000-0000-7000-8000-00000000031${adapter.name === "memory" ? "1" : "2"}`,
              now: "2026-08-13T00:04:00.000Z",
              configuration: {},
            }),
          );
          if (detached.outcome !== "create") throw new Error("Expected detached stack");
          expectUnchangedFailure(
            {
              ...input,
              contextId: detached.stack.contextId,
              checkoutId: "checkout-detached",
            },
            "DuplicateManagedIdentityError",
          );
        }
      } finally {
        await Promise.all(cases.map((adapter) => adapter.close()));
      }
    });

    it("reuses active history for prepare and refuses blocked history without writes", async () => {
      const cases = await adapters();
      try {
        for (const adapter of cases) {
          const prepared = seedCheckout(adapter.repository, adapter.name, true);
          runRepo(adapter.repository.applyCheckoutLocation(location("checkout-a", "loc-b", "/b")));
          if (prepared.outcome !== "create") throw new Error("Expected seeded stack");
          expect(runRepo(adapter.repository.getStackProjection(prepared.stack.id))).toMatchObject({
            canonicalPath: "/b",
          });
          const nextId = `00000000-0000-7000-8000-00000000020${adapter.name === "memory" ? "1" : "2"}`;
          const nextToken = `00000000-0000-7000-8000-00000000021${adapter.name === "memory" ? "1" : "2"}`;
          const activePrepare = Effect.runSyncExit(
            adapter.repository.prepareStack({
              identity: {
                projectId: `project-${adapter.name}`,
                checkoutId: "checkout-a",
                contextId: `context-${adapter.name}-unused`,
              },
              checkoutKind: "ordinary",
              checkoutRootPath: "/b",
              locationId: "loc-c",
              context: { kind: "workspace" },
              stackId: nextId,
              stackName: "second",
              paths: managedStackPaths(`/tmp/${adapter.name}-state`, nextId),
              operationToken: nextToken,
              now: "2026-08-13T00:02:00.000Z",
              configuration: {},
            }),
          );
          expect(Exit.isSuccess(activePrepare)).toBe(true);
          runRepo(adapter.repository.applyCheckoutLocation(location("checkout-a", "loc-a", "/a")));
          const blockedBefore = runRepo(adapter.repository.listIdentityClaims());
          const blockedPrepare = Effect.runSyncExit(
            adapter.repository.prepareStack({
              identity: {
                projectId: `project-${adapter.name}`,
                checkoutId: "checkout-a",
                contextId: `context-${adapter.name}-blocked`,
              },
              checkoutKind: "ordinary",
              checkoutRootPath: "/a",
              locationId: "loc-d",
              context: { kind: "workspace" },
              stackId: `00000000-0000-7000-8000-00000000022${adapter.name === "memory" ? "1" : "2"}`,
              stackName: "blocked",
              paths: managedStackPaths(
                `/tmp/${adapter.name}-state`,
                `00000000-0000-7000-8000-00000000022${adapter.name === "memory" ? "1" : "2"}`,
              ),
              operationToken: `00000000-0000-7000-8000-00000000023${adapter.name === "memory" ? "1" : "2"}`,
              now: "2026-08-13T00:03:00.000Z",
              configuration: {},
            }),
          );
          expectFailureTag(blockedPrepare, "ManagedCheckoutConflictError");
          expect(runRepo(adapter.repository.listIdentityClaims())).toEqual(blockedBefore);
        }
      } finally {
        await Promise.all(cases.map((adapter) => adapter.close()));
      }
    });

    it("protects transitive provenance chains through typed metadata pruning", async () => {
      const cases = await adapters();
      try {
        for (const adapter of cases) {
          seedCheckout(adapter.repository, adapter.name);
          runRepo(adapter.repository.applyCheckoutLocation(location("checkout-a", "loc-a", "/a")));
          runRepo(adapter.repository.applyCheckoutLocation(location("checkout-a", "loc-b", "/b")));
          runRepo(adapter.repository.applyCheckoutLocation(location("checkout-a", "loc-c", "/c")));
          expect(
            runRepo(
              adapter.repository.pruneIdentityMetadata({
                locationIds: ["loc-a", "loc-b", "loc-c"],
              }),
            ).removed,
          ).toBe(0);
        }
      } finally {
        await Promise.all(cases.map((adapter) => adapter.close()));
      }
    });

    it("protects checkout locations referenced by unfinished transitions in both adapters", async () => {
      const cases = await adapters();
      try {
        for (const adapter of cases) {
          seedCheckout(adapter.repository, adapter.name);
          runRepo(adapter.repository.applyCheckoutLocation(location("checkout-a", "loc-a", "/a")));
          runRepo(adapter.repository.applyCheckoutLocation(location("checkout-a", "loc-b", "/b")));
          runRepo(
            adapter.repository.reserveIdentityTransition({
              id: `${adapter.name}-prune-transition`,
              kind: "rebind-checkout",
              checkoutId: "checkout-a",
              path: "/a",
              now: "2026-08-13T00:01:00.000Z",
            }),
          );

          const unfinished = runRepo(
            adapter.repository.pruneIdentityMetadata({
              locationIds: ["loc-a", "loc-b"],
            }),
          );
          expect(unfinished, adapter.name).toEqual({
            removed: 0,
            prunedRecordIds: [],
            preservedRecordIds: ["loc-a", "loc-b"],
            unknownRecordIds: [],
          });

          runRepo(
            adapter.repository.advanceIdentityTransition({
              id: `${adapter.name}-prune-transition`,
              expectedPhase: "reserved",
              phase: "git-written",
              now: "2026-08-13T00:02:00.000Z",
            }),
          );
          runRepo(
            adapter.repository.finalizeIdentityTransition({
              id: `${adapter.name}-prune-transition`,
              expectedPhase: "git-written",
              now: "2026-08-13T00:03:00.000Z",
            }),
          );

          const finalized = runRepo(
            adapter.repository.pruneIdentityMetadata({
              locationIds: ["loc-a", "loc-b"],
            }),
          );
          expect(finalized, adapter.name).toEqual({
            removed: 0,
            prunedRecordIds: [],
            preservedRecordIds: ["loc-a", "loc-b"],
            unknownRecordIds: [],
          });
        }
      } finally {
        await Promise.all(cases.map((adapter) => adapter.close()));
      }
    });

    it("prunes superseded locations unless a transition or ancestry protects them", () => {
      const location = {
        id: "superseded",
        checkoutId: "checkout-a",
        canonicalPath: "/a",
        state: "superseded" as const,
        lastSeenAt: "2026-08-13T00:00:00.000Z",
      };
      const transition = {
        id: "transition",
        kind: "rebind-checkout" as const,
        phase: "reserved" as const,
        checkoutId: "checkout-a",
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-13T00:00:00.000Z",
      };
      const pathTransition = {
        ...transition,
        id: "path-transition",
        checkoutId: undefined,
        path: "/a",
      };
      expect(
        decideManagedIdentityMetadataPrune({
          locations: [location],
          locationIds: [location.id],
          transitions: [],
        }),
      ).toEqual({
        removed: 1,
        prunedRecordIds: [location.id],
        preservedRecordIds: [],
        unknownRecordIds: [],
      });
      expect(
        decideManagedIdentityMetadataPrune({
          locations: [location],
          locationIds: [location.id],
          transitions: [transition],
        }),
      ).toEqual({
        removed: 0,
        prunedRecordIds: [],
        preservedRecordIds: [location.id],
        unknownRecordIds: [],
      });
      expect(
        decideManagedIdentityMetadataPrune({
          locations: [location],
          locationIds: [location.id],
          transitions: [pathTransition],
        }),
      ).toEqual({
        removed: 0,
        prunedRecordIds: [],
        preservedRecordIds: [location.id],
        unknownRecordIds: [],
      });
      expect(
        decideManagedIdentityMetadataPrune({
          locations: [location],
          locationIds: [location.id],
          transitions: [{ ...pathTransition, phase: "git-written" }],
        }),
      ).toEqual({
        removed: 0,
        prunedRecordIds: [],
        preservedRecordIds: [location.id],
        unknownRecordIds: [],
      });
      expect(
        decideManagedIdentityMetadataPrune({
          locations: [location],
          locationIds: [location.id],
          transitions: [{ ...pathTransition, phase: "finalized" }],
        }),
      ).toEqual({
        removed: 1,
        prunedRecordIds: [location.id],
        preservedRecordIds: [],
        unknownRecordIds: [],
      });
    });

    it("enforces transition resource overlap and true phase CAS in both adapters", async () => {
      const cases = await adapters();
      try {
        for (const adapter of cases) {
          seedCheckout(adapter.repository, adapter.name);
          const first = runRepo(
            adapter.repository.reserveIdentityTransition({
              id: `${adapter.name}-transition-a`,
              kind: "rebind-checkout",
              checkoutId: "checkout-a",
              path: "/a",
              now: "2026-08-13T00:00:00.000Z",
            }),
          );
          const other = runRepo(
            adapter.repository.reserveIdentityTransition({
              id: `${adapter.name}-transition-b`,
              kind: "rebind-checkout",
              checkoutId: "checkout-b",
              path: "/b",
              now: "2026-08-13T00:00:00.000Z",
            }),
          );
          expect(other.id).not.toBe(first.id);
          const competingExit = Effect.runSyncExit(
            adapter.repository.reserveIdentityTransition({
              id: `${adapter.name}-transition-c`,
              kind: "rebind-checkout",
              checkoutId: "checkout-a",
              path: "/different",
              now: "2026-08-13T00:00:00.000Z",
            }),
          );
          expectFailureTag(competingExit, "ManagedIdentityTransitionOwnershipError");
          const malformedBefore = runRepo(adapter.repository.listIdentityClaims());
          expectFailureTag(
            Effect.runSyncExit(
              adapter.repository.reserveIdentityTransition({
                id: `${adapter.name}-transition-blank-path`,
                kind: "new-checkout",
                path: "  ",
                now: "2026-08-13T00:00:00.000Z",
              }),
            ),
            "ManagedIdentityTransitionOwnershipError",
          );
          expectFailureTag(
            Effect.runSyncExit(
              adapter.repository.reserveIdentityTransition({
                id: `${adapter.name}-transition-blank-checkout`,
                kind: "rebind-checkout",
                checkoutId: "  ",
                now: "2026-08-13T00:00:00.000Z",
              }),
            ),
            "ManagedIdentityTransitionOwnershipError",
          );
          expectFailureTag(
            Effect.runSyncExit(
              adapter.repository.reserveIdentityTransition({
                id: `${adapter.name}-transition-blank-branch`,
                kind: "adopt-context",
                projectId: " ",
                branch: "\t",
                now: "2026-08-13T00:00:00.000Z",
              }),
            ),
            "ManagedIdentityTransitionOwnershipError",
          );
          expectFailureTag(
            Effect.runSyncExit(
              adapter.repository.reserveIdentityTransition({
                id: `${adapter.name}-transition-irrelevant-path`,
                kind: "adopt-context",
                path: "/only-path",
                now: "2026-08-13T00:00:00.000Z",
              }),
            ),
            "ManagedIdentityTransitionOwnershipError",
          );
          expect(runRepo(adapter.repository.listIdentityClaims())).toEqual(malformedBefore);
          const changedReservationExit = Effect.runSyncExit(
            adapter.repository.reserveIdentityTransition({
              id: first.id,
              kind: "rebind-checkout",
              checkoutId: "checkout-a",
              path: "/a",
              now: "2026-08-13T00:00:00.000Z",
              projectId: "project-other",
            }),
          );
          expectFailureTag(changedReservationExit, "ManagedIdentityTransitionOwnershipError");
          const skip = runRepo(
            adapter.repository.reserveIdentityTransition({
              id: `${adapter.name}-transition-skip`,
              kind: "new-checkout",
              path: "/skip",
              now: "2026-08-13T00:00:00.000Z",
            }),
          );
          expectFailureTag(
            Effect.runSyncExit(
              adapter.repository.advanceIdentityTransition({
                id: skip.id,
                expectedPhase: "reserved",
                phase: "finalized",
                now: "2026-08-13T00:00:00.000Z",
              }),
            ),
            "ManagedIdentityTransitionOwnershipError",
          );
          const advanced = runRepo(
            adapter.repository.advanceIdentityTransition({
              id: first.id,
              expectedPhase: "reserved",
              phase: "git-written",
              now: "2026-08-13T00:01:00.000Z",
            }),
          );
          expect(
            runRepo(
              adapter.repository.advanceIdentityTransition({
                id: first.id,
                expectedPhase: "reserved",
                phase: "git-written",
                now: "2026-08-13T00:02:00.000Z",
              }),
            ),
          ).toEqual(advanced);
          expectFailureTag(
            Effect.runSyncExit(
              adapter.repository.advanceIdentityTransition({
                id: first.id,
                expectedPhase: "reserved",
                phase: "finalized",
                now: "2026-08-13T00:03:00.000Z",
              }),
            ),
            "ManagedIdentityTransitionOwnershipError",
          );
          const finalized = runRepo(
            adapter.repository.finalizeIdentityTransition({
              id: first.id,
              expectedPhase: "git-written",
              now: "2026-08-13T00:04:00.000Z",
            }),
          );
          expect(finalized.phase).toBe("finalized");
          expect(
            runRepo(
              adapter.repository.finalizeIdentityTransition({
                id: first.id,
                expectedPhase: "git-written",
                now: "2026-08-13T00:05:00.000Z",
              }),
            ),
          ).toEqual(finalized);
          expectFailureTag(
            Effect.runSyncExit(
              adapter.repository.advanceIdentityTransition({
                id: first.id,
                expectedPhase: "reserved",
                phase: "finalized",
                now: "2026-08-13T00:06:00.000Z",
              }),
            ),
            "ManagedIdentityTransitionOwnershipError",
          );
          expectFailureTag(
            Effect.runSyncExit(
              adapter.repository.advanceIdentityTransition({
                id: first.id,
                expectedPhase: "reserved",
                phase: "git-written",
                now: "2026-08-13T00:07:00.000Z",
              }),
            ),
            "ManagedIdentityTransitionOwnershipError",
          );
          expect(
            runRepo(
              adapter.repository.reserveIdentityTransition({
                id: `${adapter.name}-transition-e`,
                kind: "rebind-checkout",
                checkoutId: "checkout-a",
                path: "/different",
                now: "2026-08-13T00:08:00.000Z",
              }),
            ).phase,
          ).toBe("reserved");
          expect(
            runRepo(adapter.repository.listIdentityClaims(`project-${adapter.name}`)).transitions,
          ).toEqual(expect.arrayContaining([expect.objectContaining({ id: first.id })]));
        }
      } finally {
        await Promise.all(cases.map((adapter) => adapter.close()));
      }
    });

    it("abandons only an exact reserved transition and never a published one", async () => {
      const cases = await adapters();
      try {
        for (const adapter of cases) {
          const reserved = runRepo(
            adapter.repository.reserveIdentityTransition({
              id: `${adapter.name}-abandon-a`,
              kind: "new-checkout",
              projectId: "project-abandon",
              checkoutId: "checkout-abandon",
              contextId: "context-abandon",
              path: "/abandon-exact",
              expectedGitValue: "absent",
              targetGitValue: "context-abandon",
              now: "2026-08-13T00:00:00.000Z",
            }),
          );
          expect(
            runRepo(
              adapter.repository.abandonIdentityTransition({
                id: reserved.id,
                expectedPhase: "reserved",
                kind: reserved.kind,
                path: reserved.path ?? "",
                projectId: reserved.projectId,
                checkoutId: reserved.checkoutId,
                contextId: reserved.contextId,
                branch: reserved.branch,
                expectedGitValue: reserved.expectedGitValue,
                targetGitValue: reserved.targetGitValue,
              }),
            ),
          ).toEqual({ outcome: "abandoned" });
          expect(
            runRepo(
              adapter.repository.abandonIdentityTransition({
                id: reserved.id,
                expectedPhase: "reserved",
                kind: reserved.kind,
                path: reserved.path ?? "",
                projectId: reserved.projectId,
                checkoutId: reserved.checkoutId,
                contextId: reserved.contextId,
                branch: reserved.branch,
                expectedGitValue: reserved.expectedGitValue,
                targetGitValue: reserved.targetGitValue,
              }),
            ),
          ).toEqual({ outcome: "already-absent" });
          const mismatch = runRepo(
            adapter.repository.reserveIdentityTransition({
              id: `${adapter.name}-abandon-mismatch`,
              kind: "rebind-checkout",
              checkoutId: "checkout-abandon-mismatch",
              path: "/abandon-mismatch",
              now: "2026-08-13T00:00:00.000Z",
            }),
          );
          expectFailureTag(
            Effect.runSyncExit(
              adapter.repository.abandonIdentityTransition({
                id: mismatch.id,
                expectedPhase: "reserved",
                kind: mismatch.kind,
                path: "/different-path",
                checkoutId: mismatch.checkoutId,
              }),
            ),
            "ManagedIdentityTransitionOwnershipError",
          );
          const published = runRepo(
            adapter.repository.reserveIdentityTransition({
              id: `${adapter.name}-abandon-b`,
              kind: "new-checkout",
              path: "/abandon-published",
              now: "2026-08-13T00:00:00.000Z",
            }),
          );
          runRepo(
            adapter.repository.advanceIdentityTransition({
              id: published.id,
              expectedPhase: "reserved",
              phase: "git-written",
              now: "2026-08-13T00:01:00.000Z",
            }),
          );
          expectFailureTag(
            Effect.runSyncExit(
              adapter.repository.abandonIdentityTransition({
                id: published.id,
                expectedPhase: "reserved",
                kind: published.kind,
                path: published.path ?? "",
              }),
            ),
            "ManagedIdentityTransitionOwnershipError",
          );
        }
      } finally {
        await Promise.all(cases.map((adapter) => adapter.close()));
      }
    });
  });
});
