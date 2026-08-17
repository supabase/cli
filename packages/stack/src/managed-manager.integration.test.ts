import { it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { HttpServer } from "effect/unstable/http";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import {
  createManagedStackManager,
  deriveRepairOwnershipId,
  ManagedStackManager,
  managedStackManagerLayer,
} from "./managed/manager.ts";
import type { ManagedStackStartResult } from "./managed/manager.ts";
import { ManagedExactPortOccupiedError } from "./managed/model.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import { acquireControl, ControlTransport } from "./managed/control.ts";
import { deriveStackId, ensureEnvironment } from "./managed/environment.ts";
import { controlTransportLayer } from "./platform-node.ts";
import { httpTransportClientLayer } from "./HttpTransportClient.ts";
import { reservePortSet } from "./PortAllocator.ts";
import { managedStackDocumentPath, managedStackPaths } from "./managed/paths.ts";
import { Stack } from "./Stack.ts";
import { DaemonServer } from "./DaemonServer.ts";
import { git, makeRepository } from "../tests/helpers/git-workspace.ts";
import type { ManagedPortIntentDocument } from "./managed/model.ts";
import type { ManagedStackManagerShape } from "./managed/manager.ts";
import { deleteManagedStack, stopManagedStack, updateManagedLaunch } from "./managed/lifecycle.ts";
import { resolveStackSummary } from "./discovery.ts";

const roots: Array<string> = [];
const COLLIDING_STACK_A = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const COLLIDING_STACK_B = `${COLLIDING_STACK_A.slice(0, 10)}${"f".repeat(54)}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "managed-manager-test-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const stateRoot = join(root, "state");
  const layer = managedStackManagerLayer({ stateRoot });
  return { layer, stateRoot, workspace };
};

const controlStack = (): Stack["Service"] => ({
  getInfo: () =>
    Effect.succeed({
      url: "http://127.0.0.1",
      dbUrl: "postgres://127.0.0.1",
      publishableKey: "publishable",
      secretKey: "secret",
      anonJwt: "anon",
      serviceRoleJwt: "service",
      serviceEndpoints: {},
    }),
  start: () => Effect.void,
  stop: () => Effect.void,
  dispose: () => Effect.void,
  startService: () => Effect.void,
  stopService: () => Effect.void,
  restartService: () => Effect.void,
  reloadFunctions: () => Effect.void,
  reloadEdgeRuntime: () => Effect.void,
  getState: () => Effect.die("unused"),
  getAllStates: () => Effect.succeed([]),
  stateChanges: () => Effect.succeed(Stream.empty),
  allStateChanges: () => Stream.empty,
  waitReady: () => Effect.void,
  waitAllReady: () => Effect.void,
  subscribeLogs: () => Stream.empty,
  subscribeAllLogs: () => Stream.empty,
  logHistory: () => Effect.succeed([]),
  logHistoryAll: () => Effect.succeed([]),
});

const automaticDocument = (
  field: "apiPort" | "studioPort" = "apiPort",
): ManagedPortIntentDocument => ({
  activeFields: field === "apiPort" ? ["apiPort", "dbPort"] : ["apiPort", "dbPort", field],
  document: {},
});

const exactDocument = (
  field: "apiPort" | "studioPort",
  port: number,
): ManagedPortIntentDocument => ({
  activeFields: field === "apiPort" ? ["apiPort", "dbPort"] : ["apiPort", "dbPort", field],
  document: field === "apiPort" ? { api: { port } } : { studio: { port } },
});

const freePort = (): Effect.Effect<number, unknown, import("effect/Scope").Scope> =>
  Effect.gen(function* () {
    const lease = yield* reservePortSet([{ field: "apiPort", selection: { kind: "automatic" } }]);
    const port = lease.ports.apiPort;
    yield* lease.releaseAll;
    if (port === undefined) return yield* Effect.fail(new Error("missing free port"));
    return port;
  });

const startWithOwner = (
  manager: ManagedStackManagerShape,
  workspacePath: string,
  portDocument: ManagedPortIntentDocument,
  lifecycle: "stopped" | "running" = "stopped",
  stackName = "default",
) =>
  Effect.gen(function* () {
    const environment = yield* ensureEnvironment(workspacePath);
    const stackId = deriveStackId(environment.identity, stackName);
    const ownership = yield* acquireControl({ stackId });
    if (ownership._tag !== "Owned") throw new Error("expected stack control ownership");
    return yield* manager.startStack({
      workspacePath,
      stackName,
      portDocument,
      ownership,
      lifecycle,
    });
  });

const releaseLease = (result: ManagedStackStartResult): Effect.Effect<void> =>
  result.lease.releaseAll;

describe("managed stack journeys", () => {
  it.live("lets a concurrent start own the endpoint while status checks liveness", () => {
    const { layer, stateRoot, workspace } = setup();
    return Effect.gen(function* () {
      const baseTransport = yield* ControlTransport;
      const readStarted = yield* Deferred.make<void>();
      const continueRead = yield* Deferred.make<void>();
      let gateReads = false;
      const gatedTransport = Layer.succeed(ControlTransport, {
        ...baseTransport,
        read: (endpoint) =>
          gateReads
            ? Effect.gen(function* () {
                yield* Deferred.succeed(readStarted, void 0);
                yield* Deferred.await(continueRead);
                return yield* baseTransport.read(endpoint);
              })
            : baseTransport.read(endpoint),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* ManagedStackManager;
          const initial = yield* Effect.scoped(
            startWithOwner(manager, workspace, automaticDocument()),
          );
          const stackId = initial.stack.id;
          gateReads = true;

          const summaryFiber = yield* Effect.forkScoped(
            resolveStackSummary({
              cacheRoot: stateRoot,
              projectDir: workspace,
              name: "default",
            }),
          );
          yield* Deferred.await(readStarted).pipe(Effect.timeout("1 second"));

          const owner = yield* acquireControl({
            stackId,
            initialStatus: {
              protocolVersion: 1,
              ownershipId: stackId,
              state: "running",
              ready: true,
            },
          });
          if (owner._tag !== "Owned") throw new Error("status probe took control ownership");
          yield* Deferred.succeed(continueRead, void 0);
          const summary = yield* Fiber.join(summaryFiber);
          expect(summary.running).toBe(true);
        }),
      ).pipe(
        Effect.provide(layer),
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(NodePath.layer),
        Effect.provide(gitConfigStoreLayer),
        Effect.provide(gatedTransport),
      );
    }).pipe(Effect.provide(controlTransportLayer));
  });

  it.live("updates launch metadata and recovers a stale owner through the lifecycle facade", () => {
    const { layer, workspace } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const environment = yield* ensureEnvironment(workspace);
        const stackId = deriveStackId(environment.identity, "default");
        const owner = yield* acquireControl({ stackId });
        if (owner._tag !== "Owned") throw new Error("expected stack control ownership");
        const started = yield* manager.startStack({
          workspacePath: workspace,
          stackName: "default",
          portDocument: automaticDocument(),
          ownership: owner,
          lifecycle: "running",
        });
        yield* releaseLease(started);
        yield* owner.close;

        const input = {
          workspacePath: workspace,
          stackName: "default",
          launch: {
            mode: "auto" as const,
            versions: { postgres: "17.6.1" },
            excludedServices: [],
          },
        };
        const updated = yield* updateManagedLaunch(input);
        expect(updated.launch).toEqual(input.launch);

        yield* stopManagedStack(input);
        const stopped = yield* manager.inspectStack(stackId);
        expect(stopped?.lifecycle).toBe("stopped");
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
      Effect.provide(httpTransportClientLayer),
    );
  });

  it.live("restarts the same environment with the same automatic ports", () => {
    const { layer, workspace } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const environment = yield* ensureEnvironment(workspace);
        const stackId = deriveStackId(environment.identity, "default");
        const ownership = yield* acquireControl({ stackId });
        if (ownership._tag !== "Owned") throw new Error("expected stack control ownership");
        const first = yield* manager.startStack({
          workspacePath: workspace,
          portDocument: { activeFields: ["apiPort", "dbPort"], document: {} },
          ownership,
        });
        yield* releaseLease(first);
        const second = yield* manager.startStack({
          workspacePath: workspace,
          portDocument: { activeFields: ["apiPort", "dbPort"], document: {} },
          ownership,
        });
        if (first === undefined || second === undefined) throw new Error("expected stack");
        expect(second.stack.id).toBe(first.stack.id);
        expect(second.stack.ports).toEqual(first.stack.ports);
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });

  it.live("starts sibling worktrees concurrently with independent automatic ports", () => {
    const { layer } = setup();
    const siblingRoot = mkdtempSync(join(tmpdir(), "managed-sibling-test-"));
    roots.push(siblingRoot);
    const repository = makeRepository(siblingRoot);
    const firstWorkspace = join(siblingRoot, "first");
    const secondWorkspace = join(siblingRoot, "second");
    git(repository, "worktree", "add", "-q", firstWorkspace, "-b", "first", "main");
    git(repository, "worktree", "add", "-q", secondWorkspace, "-b", "second", "main");
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const [first, second] = yield* Effect.all(
          [
            startWithOwner(manager, firstWorkspace, automaticDocument()),
            startWithOwner(manager, secondWorkspace, automaticDocument()),
          ],
          { concurrency: "unbounded" },
        );
        expect(first.stack.id).not.toBe(second.stack.id);
        const firstPorts = new Set(first.stack.ports.map((assignment) => assignment.port));
        expect(second.stack.ports.some((assignment) => firstPorts.has(assignment.port))).toBe(
          false,
        );
        const listings = yield* manager.listStacks();
        expect(listings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: first.stack.id, status: "healthy" }),
            expect.objectContaining({ id: second.stack.id, status: "healthy" }),
          ]),
        );
        yield* releaseLease(first);
        yield* releaseLease(second);
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });

  it.live("allows stopped exact siblings and rejects a live owner", () => {
    const { layer } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const port = yield* freePort();
        const firstWorkspace = setup().workspace;
        const secondWorkspace = setup().workspace;
        const first = yield* startWithOwner(
          manager,
          firstWorkspace,
          exactDocument("apiPort", port),
        );
        yield* releaseLease(first);
        const second = yield* startWithOwner(
          manager,
          secondWorkspace,
          exactDocument("apiPort", port),
        );
        yield* releaseLease(second);
        const liveWorkspace = setup().workspace;
        const live = yield* startWithOwner(
          manager,
          liveWorkspace,
          exactDocument("apiPort", port),
          "running",
        );
        const rejectedWorkspace = setup().workspace;
        const rejected = yield* startWithOwner(
          manager,
          rejectedWorkspace,
          exactDocument("apiPort", port),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(rejected)).toBe(true);
        if (Exit.isFailure(rejected)) {
          expect(Cause.squash(rejected.cause)).toBeInstanceOf(ManagedExactPortOccupiedError);
        }
        yield* releaseLease(live);
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });

  it.live("keeps automatic ports exclusive while stopped", () => {
    const { layer } = setup();
    const root = mkdtempSync(join(tmpdir(), "managed-auto-test-"));
    roots.push(root);
    const firstWorkspace = join(root, "first");
    const secondWorkspace = join(root, "second");
    mkdirSync(firstWorkspace);
    mkdirSync(secondWorkspace);
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const environment = yield* ensureEnvironment(firstWorkspace);
        const stackId = deriveStackId(environment.identity, "default");
        const ownership = yield* acquireControl({ stackId });
        if (ownership._tag !== "Owned") throw new Error("expected ownership");
        const first = yield* manager.startStack({
          workspacePath: firstWorkspace,
          portDocument: automaticDocument(),
          ownership,
        });
        yield* releaseLease(first);
        const firstPort = first.stack.ports[0]?.port;
        if (firstPort === undefined) throw new Error("expected automatic port");
        const external = yield* reservePortSet([
          { field: "apiPort", selection: { kind: "exact", port: firstPort } },
        ]);
        const restart = yield* manager
          .startStack({
            workspacePath: firstWorkspace,
            portDocument: automaticDocument(),
            ownership,
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(restart)).toBe(true);
        yield* external.releaseAll;
        const second = yield* startWithOwner(manager, secondWorkspace, automaticDocument());
        expect(second.stack.ports[0]?.port).not.toBe(first.stack.ports[0]?.port);
        yield* releaseLease(second);
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });

  it.live("reports running drift and applies it after stop", () => {
    const { layer } = setup();
    const root = mkdtempSync(join(tmpdir(), "managed-drift-test-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const original = yield* freePort();
        const changed = yield* freePort();
        const environment = yield* ensureEnvironment(workspace);
        const stackId = deriveStackId(environment.identity, "default");
        const initialOwnership = yield* acquireControl({ stackId });
        if (initialOwnership._tag !== "Owned") throw new Error("expected ownership");
        const running = yield* manager.startStack({
          workspacePath: workspace,
          portDocument: exactDocument("apiPort", original),
          ownership: initialOwnership,
          lifecycle: "running",
        });
        const status = yield* manager.readStack({
          workspacePath: workspace,
          portDocument: exactDocument("apiPort", changed),
        });
        expect(status?.drift).toHaveLength(1);
        yield* releaseLease(running);
        yield* manager.recordLifecycle(initialOwnership, { stackId, lifecycle: "stopped" });
        yield* initialOwnership.close;
        const ownership = yield* acquireControl({ stackId });
        if (ownership._tag !== "Owned") throw new Error("expected ownership");
        const stopped = yield* manager.startStack({
          workspacePath: workspace,
          portDocument: exactDocument("apiPort", changed),
          ownership,
          lifecycle: "stopped",
        });
        expect(stopped.stack.ports[0]?.port).toBe(changed);
        yield* releaseLease(stopped);
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });

  it.live("preserves removed-key and disabled-service intent", () => {
    const { layer } = setup();
    const root = mkdtempSync(join(tmpdir(), "managed-retired-test-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const port = yield* freePort();
        const env = yield* ensureEnvironment(workspace);
        const stackId = deriveStackId(env.identity, "default");
        const ownership = yield* acquireControl({ stackId });
        if (ownership._tag !== "Owned") throw new Error("expected ownership");
        const first = yield* manager.startStack({
          workspacePath: workspace,
          portDocument: exactDocument("studioPort", port),
          ownership,
        });
        yield* releaseLease(first);
        const disabled = yield* manager.startStack({
          workspacePath: workspace,
          portDocument: { activeFields: [], disabledFields: ["studioPort"], document: {} },
          ownership,
        });
        expect(
          disabled.stack.ports.filter((assignment) => assignment.key === "studio.port"),
        ).toEqual([{ key: "studio.port", port, intent: "exact" }]);
        yield* releaseLease(disabled);
        const removed = yield* manager.startStack({
          workspacePath: workspace,
          portDocument: { activeFields: [], document: {} },
          ownership,
        });
        expect(
          removed.stack.ports.filter((assignment) => assignment.key === "studio.port"),
        ).toEqual([{ key: "studio.port", port, intent: "automatic" }]);
        yield* releaseLease(removed);
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });

  it.live("reclaims a stale starting document after its owner closes", () => {
    const { layer, workspace } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const environment = yield* ensureEnvironment(workspace);
        const stackId = deriveStackId(environment.identity, "default");
        const previousOwner = yield* acquireControl({ stackId });
        if (previousOwner._tag !== "Owned") throw new Error("expected ownership");
        const starting = yield* manager.startStack({
          workspacePath: workspace,
          portDocument: automaticDocument(),
          ownership: previousOwner,
          lifecycle: "starting",
        });
        yield* releaseLease(starting);
        yield* previousOwner.close;
        const nextOwner = yield* acquireControl({ stackId });
        if (nextOwner._tag !== "Owned") throw new Error("expected reattached ownership");
        const recovered = yield* manager.startStack({
          workspacePath: workspace,
          portDocument: automaticDocument(),
          ownership: nextOwner,
          lifecycle: "stopped",
        });
        expect(recovered.stack.lifecycle).toBe("stopped");
        expect(recovered.stack.ports).toEqual(starting.stack.ports);
        yield* releaseLease(recovered);
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });

  it.live("finishes an interrupted delete before the next start", () => {
    const { layer, stateRoot, workspace } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const environment = yield* ensureEnvironment(workspace);
        const stackId = deriveStackId(environment.identity, "default");
        const previousOwner = yield* acquireControl({ stackId });
        if (previousOwner._tag !== "Owned") throw new Error("expected ownership");
        const previous = yield* manager.startStack({
          workspacePath: workspace,
          portDocument: automaticDocument(),
          ownership: previousOwner,
        });
        yield* releaseLease(previous);
        const dataPath = join(managedStackPaths(stateRoot, stackId).data, "orphaned");
        mkdirSync(managedStackPaths(stateRoot, stackId).data, { recursive: true });
        writeFileSync(dataPath, "stale");
        yield* manager.recordLifecycle(previousOwner, { stackId, lifecycle: "deleting" });
        yield* previousOwner.close;

        const nextOwner = yield* acquireControl({ stackId });
        if (nextOwner._tag !== "Owned") throw new Error("expected recovered ownership");
        const restarted = yield* manager.startStack({
          workspacePath: workspace,
          portDocument: automaticDocument(),
          ownership: nextOwner,
        });
        expect(restarted.stack.lifecycle).toBe("stopped");
        expect(existsSync(dataPath)).toBe(false);
        yield* releaseLease(restarted);
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });

  it.live("fences start publication while checkout repair is owned", () => {
    const { layer, workspace } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const environment = yield* ensureEnvironment(workspace);
        const stackId = deriveStackId(environment.identity, "default");
        const repairId = deriveRepairOwnershipId(environment.identity);
        const repairOwner = yield* acquireControl({ stackId: repairId });
        if (repairOwner._tag !== "Owned") throw new Error("expected repair ownership");
        const repairDaemon = ManagedRuntime.make(
          DaemonServer.layerWithShutdown(Effect.void, repairOwner.ownerStatus).pipe(
            Layer.provide(Layer.succeed(Stack, controlStack())),
            Layer.provide(Layer.succeed(HttpServer.HttpServer, repairOwner.server)),
          ),
        );
        yield* Effect.promise(() => repairDaemon.runPromise(DaemonServer));
        const stackOwner = yield* acquireControl({ stackId });
        if (stackOwner._tag !== "Owned") throw new Error("expected stack ownership");
        const blocked = yield* manager
          .startStack({
            workspacePath: workspace,
            portDocument: automaticDocument(),
            ownership: stackOwner,
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(blocked)).toBe(true);
        expect(yield* manager.inspectStack(stackId)).toBeUndefined();
        yield* repairOwner.close;
        yield* Effect.promise(() => repairDaemon.dispose());
        const wrongOwner = yield* acquireControl({ stackId: "e".repeat(64) });
        if (wrongOwner._tag !== "Owned") throw new Error("expected unrelated ownership");
        const unauthorized = yield* manager
          .startStack({
            workspacePath: workspace,
            portDocument: automaticDocument(),
            ownership: wrongOwner,
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(unauthorized)).toBe(true);
        yield* wrongOwner.close;
        const started = yield* manager.startStack({
          workspacePath: workspace,
          portDocument: automaticDocument(),
          ownership: stackOwner,
        });
        expect(started.stack.id).toBe(stackId);
        yield* releaseLease(started);
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });

  it.live("rejects a colliding control capability for another stack id", () => {
    const { layer } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const ownership = yield* acquireControl({ stackId: COLLIDING_STACK_A });
        if (ownership._tag !== "Owned") throw new Error("expected ownership");
        const rejected = yield* manager
          .allocateManagedPorts(ownership, {
            stackId: COLLIDING_STACK_B,
            portDocument: automaticDocument(),
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(rejected)).toBe(true);
        if (Exit.isFailure(rejected)) {
          expect(Cause.squash(rejected.cause)).toMatchObject({
            _tag: "ManagedStackControlRequiredError",
          });
        }
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });

  it.live("keeps Promise allocation ports bound until disposal", () => {
    const { layer, workspace } = setup();
    return Effect.promise(async () => {
      const platformLayer = Layer.mergeAll(
        NodeFileSystem.layer,
        NodePath.layer,
        gitConfigStoreLayer,
        controlTransportLayer,
      );
      const manager = await createManagedStackManager(layer.pipe(Layer.provide(platformLayer)));
      const environment = await Effect.runPromise(
        ensureEnvironment(workspace).pipe(Effect.provide(platformLayer)),
      );
      const stackId = deriveStackId(environment.identity, "default");
      const ownerScope = await Effect.runPromise(Scope.make());
      const ownership = await Effect.runPromise(
        acquireControl({ stackId })
          .pipe(Effect.provideService(Scope.Scope, ownerScope))
          .pipe(Effect.provide(controlTransportLayer)),
      );
      if (ownership._tag !== "Owned") throw new Error("expected ownership");
      const allocation = await manager.startStack({
        workspacePath: workspace,
        portDocument: automaticDocument(),
        ownership,
      });
      const port = allocation.ports.apiPort;
      if (port === undefined) throw new Error("expected API port");
      const blocked = await Effect.runPromise(
        reservePortSet([{ field: "apiPort", selection: { kind: "exact", port } }]).pipe(
          Effect.exit,
        ),
      );
      expect(Exit.isFailure(blocked)).toBe(true);
      await allocation.releaseAll();
      const rebound = await Effect.runPromise(
        reservePortSet([{ field: "apiPort", selection: { kind: "exact", port } }]),
      );
      await Effect.runPromise(rebound.releaseAll);
      await Effect.runPromise(Scope.close(ownerScope, Exit.void));
      await manager[Symbol.asyncDispose]();
    });
  });

  it.live("repairs a moved workspace without changing stack id or ports", () => {
    const { layer, stateRoot } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), "managed-repair-test-"));
        roots.push(root);
        const repository = makeRepository(root);
        const manager = yield* ManagedStackManager;
        const original = yield* Effect.scoped(
          startWithOwner(manager, repository, automaticDocument()),
        );
        const secondary = yield* Effect.scoped(
          startWithOwner(manager, repository, automaticDocument(), "stopped", "secondary"),
        );
        const originalId = original.stack.id;
        const originalPort = original.stack.ports[0]?.port;
        const secondaryId = secondary.stack.id;
        const moved = join(root, "moved");
        renameSync(repository, moved);
        const discovery = yield* manager.discoverWorkspace(moved);
        if (discovery.state !== "needsRepair") throw new Error("expected repair");
        const deleteBeforeRepair = yield* deleteManagedStack({ workspacePath: moved }).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(deleteBeforeRepair)).toBe(true);
        const blockedId = [originalId, secondaryId].sort().at(-1);
        if (blockedId === undefined) throw new Error("expected affected stack");
        const blockedRoot = managedStackPaths(stateRoot, blockedId).root;
        chmodSync(blockedRoot, 0o500);
        const failed = yield* manager.repairWorkspace(discovery.repair).pipe(Effect.exit);
        chmodSync(blockedRoot, 0o700);
        expect(Exit.isFailure(failed)).toBe(true);
        const firstUpdatedId = [originalId, secondaryId].sort().at(0);
        if (firstUpdatedId === undefined) throw new Error("expected affected stack");
        const partial = yield* manager.inspectStack(firstUpdatedId);
        expect(partial?.workspace.path).toBe(discovery.path);
        const stillNeedsRepair = yield* manager.discoverWorkspace(moved);
        expect(stillNeedsRepair.state).toBe("needsRepair");
        const repaired = yield* manager.repairWorkspace(discovery.repair);
        expect(repaired.state).toBe("healthy");
        const stack = yield* manager.inspectStack(originalId);
        expect(stack?.id).toBe(originalId);
        expect(stack?.ports[0]?.port).toBe(originalPort);
        expect(stack?.workspace.path).toBe(repaired.path);
        const repairedSecondary = yield* manager.inspectStack(secondaryId);
        expect(repairedSecondary?.workspace.path).toBe(repaired.path);
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });

  it.live("lists corrupt and healthy stacks together", () => {
    const { layer, stateRoot, workspace } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const stack = yield* startWithOwner(manager, workspace, automaticDocument());
        yield* releaseLease(stack);
        const corruptId = "f".repeat(64);
        mkdirSync(managedStackPaths(stateRoot, corruptId).root, { recursive: true });
        writeFileSync(managedStackDocumentPath(stateRoot, corruptId), "not-json");
        const listings = yield* manager.listStacks();
        expect(listings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: stack.stack.id, status: "healthy" }),
            expect.objectContaining({ id: corruptId, status: "corrupt" }),
          ]),
        );
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });
});
