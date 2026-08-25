import { it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Layer } from "effect";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { ManagedStackManager, managedStackManagerLayer } from "./managed/manager.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import { acquireControl, ControlTransport, isControlOwnership } from "./managed/control.ts";
import { deriveStackId, ensureEnvironment } from "./managed/environment.ts";
import { controlTransportLayer } from "./platform-node.ts";
import { httpTransportClientLayer } from "./HttpTransportClient.ts";
import { managedStackDocumentPathEffect, managedStackPathsEffect } from "./managed/paths.ts";
import { Stack } from "./Stack.ts";
import { SupervisorControlServer } from "./SupervisorControlServer.ts";
import { makeSupervisorSessionFixture } from "../tests/helpers/SupervisorSessionFixture.ts";
import {
  connectManagedStack,
  deleteManagedStack,
  stopManagedStack,
  updateManagedLaunch,
} from "./managed/lifecycle.ts";
import { DaemonUpgradeRequired } from "./errors.ts";
import {
  automaticDocument,
  cleanupRoots,
  controlStack,
  exactCoreDocument,
  freePorts,
  releaseLease,
  setupManagedManager,
  startManagedStack,
} from "../tests/helpers/managed-manager.ts";

const roots: Array<string> = [];
afterEach(() => cleanupRoots(roots));
const setup = () => setupManagedManager(roots);

describe("managed stack lifecycle journeys", () => {
  it.live("updates launch metadata and recovers a stale owner through the lifecycle facade", () => {
    const { layer, workspace } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const [apiPort, dbPort] = yield* freePorts(2);
        if (apiPort === undefined || dbPort === undefined) {
          throw new Error("expected free managed stack ports");
        }
        const portDocument = exactCoreDocument(apiPort, dbPort);
        const environment = yield* ensureEnvironment(workspace);
        const stackId = deriveStackId(environment.identity, "default");
        const owner = yield* acquireControl({ stackId });
        if (!isControlOwnership(owner)) throw new Error("expected stack control ownership");
        const started = yield* startManagedStack(manager, {
          workspacePath: workspace,
          stackName: "default",
          portDocument,
          ownership: owner,
          lifecycle: "running",
          launch: { mode: "native", versions: {} },
        });
        yield* releaseLease(started);
        yield* owner.close;

        const input = {
          workspacePath: workspace,
          stackName: "default",
          cliVersion: "test",
          launch: {
            versions: { postgres: "17.6.1" },
            excludedServices: [],
          },
        };
        const updated = yield* updateManagedLaunch(input);
        expect(updated.launch).toEqual({ mode: "native", ...input.launch });

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

  it.live("preserves launch mode while updating metadata without a runtime owner", () => {
    const { layer, workspace } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const [apiPort, dbPort] = yield* freePorts(2);
        if (apiPort === undefined || dbPort === undefined) {
          throw new Error("expected free managed stack ports");
        }
        const environment = yield* ensureEnvironment(workspace);
        const stackId = deriveStackId(environment.identity, "default");
        const owner = yield* acquireControl({ stackId });
        if (!isControlOwnership(owner)) throw new Error("expected stack control ownership");
        const started = yield* startManagedStack(manager, {
          workspacePath: workspace,
          stackName: "default",
          portDocument: exactCoreDocument(apiPort, dbPort),
          ownership: owner,
          lifecycle: "running",
        });
        yield* releaseLease(started);
        yield* owner.close;

        const updated = yield* updateManagedLaunch({
          workspacePath: workspace,
          stackName: "default",
          cliVersion: "test",
          launch: {
            versions: { postgres: "17.6.1" },
            excludedServices: ["studio"],
            lastNotifiedUpdateFingerprint: "fingerprint",
          },
        });

        expect(updated.launch).toEqual({
          mode: "native",
          versions: { postgres: "17.6.1" },
          excludedServices: ["studio"],
          lastNotifiedUpdateFingerprint: "fingerprint",
        });
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

  it.live("stops an owner whose document is still starting", () => {
    const { layer, workspace } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const environment = yield* ensureEnvironment(workspace);
        const stackId = deriveStackId(environment.identity, "default");
        const stopped = { value: false };
        const localStack = {
          ...controlStack(),
          stop: () => Effect.sync(() => void (stopped.value = true)),
        } satisfies Stack["Service"];
        const ownerSessionId = crypto.randomUUID();
        const lifecycle = yield* makeSupervisorSessionFixture({
          ownershipId: stackId,
          ownerSessionId,
          daemonCliVersion: "test",
          close: Effect.void,
        });
        const application = {
          app: yield* SupervisorControlServer.make(lifecycle),
        };
        const owner = yield* acquireControl({
          stackId,
          initialStatus: {
            controlProtocol: "supabase-stack-control",
            controlProtocolVersion: 1,
            ownershipId: stackId,
            ownerSessionId,
            state: "starting",
            ready: false,
            daemonCliVersion: "test",
          },
          application,
        });
        if (!isControlOwnership(owner)) throw new Error("expected static owner");
        yield* lifecycle.setClose(
          manager
            .recordLifecycle(owner, { stackId, lifecycle: "stopped" })
            .pipe(Effect.asVoid, Effect.andThen(owner.close)),
        );
        const started = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: automaticDocument(),
          ownership: owner,
          lifecycle: "starting",
        });
        yield* releaseLease(started);
        yield* lifecycle.publishStack(localStack);

        const stopFiber = yield* Effect.forkScoped(stopManagedStack({ workspacePath: workspace }));
        yield* Fiber.join(stopFiber);
        expect(stopped.value).toBe(true);
        expect((yield* manager.inspectStack(stackId))?.lifecycle).toBe("stopped");
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

  it.live("reports a CLI mismatch before rejecting an incompatible starting owner", () => {
    const { layer, workspace } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const environment = yield* ensureEnvironment(workspace);
        const stackId = deriveStackId(environment.identity, "default");
        const lifecycle = yield* makeSupervisorSessionFixture({
          ownershipId: stackId,
          ownerSessionId: crypto.randomUUID(),
          daemonCliVersion: "old-cli",
        });
        const owner = yield* acquireControl({
          stackId,
          initialStatus: yield* lifecycle.currentStatus,
          application: { app: yield* SupervisorControlServer.make(lifecycle) },
        });
        if (!isControlOwnership(owner)) throw new Error("expected static owner");
        const started = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: automaticDocument(),
          ownership: owner,
          lifecycle: "starting",
        });
        yield* releaseLease(started);
        yield* lifecycle.setClose(owner.close);

        const result = yield* connectManagedStack({
          workspacePath: workspace,
          cliVersion: "new-cli",
        }).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          const error = Cause.squash(result.cause);
          expect(error).toBeInstanceOf(DaemonUpgradeRequired);
          if (error instanceof DaemonUpgradeRequired) {
            expect(error).toMatchObject({ state: "starting", ready: false });
          }
        }
        yield* lifecycle.requestShutdown("dispose").pipe(Effect.ignore);
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

  it.live("preserves launch metadata when lifecycle stop races its document update", () => {
    const { stateRoot, workspace } = setup();
    const gate = { enabled: false, reads: 0 };
    let firstRead!: Deferred.Deferred<void>;
    let secondRead!: Deferred.Deferred<void>;
    let releaseFirst!: Deferred.Deferred<void>;
    let releaseSecond!: Deferred.Deferred<void>;
    const gatedFileSystemLayer = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const base = yield* FileSystem.FileSystem;
        return {
          ...base,
          readFileString: (path: string, options?: Parameters<typeof base.readFileString>[1]) => {
            if (!gate.enabled || !path.endsWith("stack.json")) {
              return base.readFileString(path, options);
            }
            return Effect.gen(function* () {
              const contents = yield* base.readFileString(path, options);
              gate.reads += 1;
              const first = gate.reads === 1;
              const signal = first ? firstRead : secondRead;
              yield* Deferred.succeed(signal, void 0);
              yield* Deferred.await(first ? releaseFirst : releaseSecond);
              return contents;
            });
          },
        } satisfies FileSystem.FileSystem;
      }),
    ).pipe(Layer.provide(NodeFileSystem.layer));
    const managerLayer = managedStackManagerLayer({ stateRoot, preferCatalogDefaults: false }).pipe(
      Layer.provide(gatedFileSystemLayer),
      Layer.provide(NodePath.layer),
      Layer.provide(gitConfigStoreLayer),
      Layer.provide(controlTransportLayer),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        firstRead = yield* Deferred.make<void>();
        secondRead = yield* Deferred.make<void>();
        releaseFirst = yield* Deferred.make<void>();
        releaseSecond = yield* Deferred.make<void>();
        const manager = yield* ManagedStackManager;
        const environment = yield* ensureEnvironment(workspace);
        const stackId = deriveStackId(environment.identity, "default");
        const owner = yield* acquireControl({ stackId });
        if (!isControlOwnership(owner)) throw new Error("expected ownership");
        const initial = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: automaticDocument(),
          ownership: owner,
          lifecycle: "running",
          launch: { mode: "native", versions: {} },
        });
        yield* releaseLease(initial);
        const launch = {
          versions: { postgres: "17.6.1" },
        };
        gate.enabled = true;
        const launchFiber = yield* manager
          .updateLaunch(owner, { stackId, launch })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(firstRead);
        const stopFiber = yield* manager
          .recordLifecycle(owner, { stackId, lifecycle: "stopped" })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        const secondAlreadyRead = yield* Deferred.isDone(secondRead);
        yield* Deferred.succeed(releaseFirst, void 0);
        if (secondAlreadyRead) {
          yield* Fiber.join(launchFiber);
        } else {
          yield* Deferred.await(secondRead);
        }
        yield* Deferred.succeed(releaseSecond, void 0);
        gate.enabled = false;
        yield* Fiber.join(launchFiber);
        yield* Fiber.join(stopFiber);
        const final = yield* manager.inspectStack(stackId);
        expect(final?.lifecycle).toBe("stopped");
        expect(final?.launch).toEqual({ mode: "native", ...launch });
      }),
    ).pipe(
      Effect.provide(managerLayer),
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
        if (!isControlOwnership(previousOwner)) throw new Error("expected ownership");
        const starting = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: automaticDocument(),
          ownership: previousOwner,
          lifecycle: "starting",
        });
        yield* releaseLease(starting);
        yield* previousOwner.close;
        const nextOwner = yield* acquireControl({ stackId });
        if (!isControlOwnership(nextOwner)) throw new Error("expected reattached ownership");
        const recovered = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: {
            activeFields: [],
            disabledFields: ["apiPort", "dbPort"],
            document: {},
          },
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

  it.live("deletes a stale running document after its owner closes", () => {
    const { layer, workspace } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const environment = yield* ensureEnvironment(workspace);
        const stackId = deriveStackId(environment.identity, "default");
        const owner = yield* acquireControl({ stackId });
        if (!isControlOwnership(owner)) throw new Error("expected ownership");
        const running = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: automaticDocument(),
          ownership: owner,
          lifecycle: "running",
          runtime: { pid: 1, controlEndpoint: owner.endpoint.url, protocolVersion: 1 },
        });
        yield* releaseLease(running);
        yield* owner.close;

        yield* deleteManagedStack({ workspacePath: workspace });
        expect(yield* manager.inspectStack(stackId)).toBeUndefined();
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });

  it.live("keeps delete ownership bound until destructive cleanup finishes", () => {
    const { layer, stateRoot, workspace } = setup();
    let armed = false;
    let documentPath: string | undefined;
    let entered!: Deferred.Deferred<void>;
    let release!: Deferred.Deferred<void>;
    const gatedFileSystemLayer = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const base = yield* FileSystem.FileSystem;
        return {
          ...base,
          remove: (path: string, options?: Parameters<typeof base.remove>[1]) => {
            if (armed && documentPath === path) {
              armed = false;
              return Effect.gen(function* () {
                yield* Deferred.succeed(entered, void 0);
                yield* Deferred.await(release);
                return yield* base.remove(path, options);
              });
            }
            return base.remove(path, options);
          },
        } satisfies FileSystem.FileSystem;
      }),
    ).pipe(Layer.provide(NodeFileSystem.layer));
    const managerLayer = layer.pipe(Layer.provide(gatedFileSystemLayer));
    return Effect.scoped(
      Effect.gen(function* () {
        entered = yield* Deferred.make<void>();
        release = yield* Deferred.make<void>();
        const manager = yield* ManagedStackManager;
        const environment = yield* ensureEnvironment(workspace);
        const stackId = deriveStackId(environment.identity, "default");
        documentPath = yield* managedStackDocumentPathEffect(stateRoot, stackId);
        const owner = yield* acquireControl({ stackId });
        if (!isControlOwnership(owner)) throw new Error("expected ownership");
        const started = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: automaticDocument(),
          ownership: owner,
          lifecycle: "stopped",
        });
        yield* releaseLease(started);
        yield* owner.close;

        armed = true;
        const deleting = yield* Effect.forkScoped(deleteManagedStack({ workspacePath: workspace }));
        yield* Deferred.await(entered);

        const probe = yield* manager.probeControl(stackId);
        if (probe === undefined) throw new Error("expected deleting owner");
        const response = yield* Effect.tryPromise(() =>
          fetch(`${probe.endpoint.url}/stop`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ownershipId: stackId,
              ownerSessionId: probe.status.ownerSessionId,
            }),
          }),
        );
        expect(response.status).toBe(202);
        yield* Effect.promise(() => response.arrayBuffer());

        const replacement = yield* manager.acquireControl(stackId);
        expect(isControlOwnership(replacement)).toBe(false);

        yield* Deferred.succeed(release, void 0);
        yield* Fiber.join(deleting);
        expect(yield* manager.inspectStack(stackId)).toBeUndefined();
      }),
    ).pipe(
      Effect.provide(managerLayer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });

  it.live(
    "keeps a stack document when its identity changes before delete ownership settles",
    () => {
      const { layer, workspace } = setup();
      const copied = join(workspace, "..", "delete-race-copy");
      let armed = false;
      let markerSwapped!: Deferred.Deferred<void>;
      const gatedTransport = Layer.effect(
        ControlTransport,
        Effect.gen(function* () {
          const base = yield* ControlTransport;
          return {
            ...base,
            read: (endpoint: Parameters<typeof base.read>[0]) =>
              Effect.gen(function* () {
                if (armed) {
                  armed = false;
                  writeFileSync(
                    join(copied, ".supabase", "identity.json"),
                    readFileSync(join(workspace, ".supabase", "identity.json")),
                  );
                  yield* Deferred.succeed(markerSwapped, void 0);
                }
                return yield* base.read(endpoint);
              }),
          } satisfies typeof base;
        }),
      ).pipe(Layer.provide(controlTransportLayer));
      const managerLayer = layer.pipe(Layer.provide(gatedTransport));
      return Effect.scoped(
        Effect.gen(function* () {
          markerSwapped = yield* Deferred.make<void>();
          const manager = yield* ManagedStackManager;
          const originalEnvironment = yield* ensureEnvironment(workspace);
          const originalStackId = deriveStackId(originalEnvironment.identity, "default");
          const originalOwner = yield* acquireControl({ stackId: originalStackId });
          if (!isControlOwnership(originalOwner)) throw new Error("expected original ownership");
          const original = yield* startManagedStack(manager, {
            workspacePath: workspace,
            portDocument: automaticDocument(),
            ownership: originalOwner,
            lifecycle: "stopped",
          });
          yield* releaseLease(original);
          yield* originalOwner.close;

          mkdirSync(copied);
          const copiedEnvironment = yield* ensureEnvironment(copied);
          const copiedStackId = deriveStackId(copiedEnvironment.identity, "default");
          const copiedOwner = yield* acquireControl({ stackId: copiedStackId });
          if (!isControlOwnership(copiedOwner)) throw new Error("expected copied ownership");
          const copiedStack = yield* startManagedStack(manager, {
            workspacePath: copied,
            portDocument: automaticDocument(),
            ownership: copiedOwner,
            lifecycle: "stopped",
          });
          yield* releaseLease(copiedStack);

          armed = true;
          const deleting = yield* Effect.forkScoped(deleteManagedStack({ workspacePath: copied }));
          yield* Deferred.await(markerSwapped);
          yield* copiedOwner.close;
          const result = yield* Fiber.join(deleting).pipe(Effect.exit);
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result)) {
            expect(Cause.squash(result.cause)).toMatchObject({
              _tag: "InvalidManagedIdentityError",
            });
          }
          expect(yield* manager.inspectStack(copiedStackId)).toBeDefined();
        }),
      ).pipe(
        Effect.provide(managerLayer),
        Effect.provide(gatedTransport),
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(NodePath.layer),
        Effect.provide(gitConfigStoreLayer),
      );
    },
  );

  it.live("rejects stop when workspace identity changes while control ownership settles", () => {
    const { layer, workspace } = setup();
    const copied = join(workspace, "..", "stop-race-copy");
    let armed = false;
    let markerSwapped!: Deferred.Deferred<void>;
    const gatedTransport = Layer.effect(
      ControlTransport,
      Effect.gen(function* () {
        const base = yield* ControlTransport;
        return {
          ...base,
          read: (endpoint: Parameters<typeof base.read>[0]) =>
            Effect.gen(function* () {
              if (armed) {
                armed = false;
                writeFileSync(
                  join(copied, ".supabase", "identity.json"),
                  readFileSync(join(workspace, ".supabase", "identity.json")),
                );
                yield* Deferred.succeed(markerSwapped, void 0);
              }
              return yield* base.read(endpoint);
            }),
        } satisfies typeof base;
      }),
    ).pipe(Layer.provide(controlTransportLayer));
    const managerLayer = layer.pipe(Layer.provide(gatedTransport));
    return Effect.scoped(
      Effect.gen(function* () {
        markerSwapped = yield* Deferred.make<void>();
        const manager = yield* ManagedStackManager;
        const originalEnvironment = yield* ensureEnvironment(workspace);
        const originalStackId = deriveStackId(originalEnvironment.identity, "default");
        const originalOwner = yield* acquireControl({ stackId: originalStackId });
        if (!isControlOwnership(originalOwner)) throw new Error("expected original ownership");
        const original = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: automaticDocument(),
          ownership: originalOwner,
          lifecycle: "stopped",
        });
        yield* releaseLease(original);
        yield* originalOwner.close;

        mkdirSync(copied);
        const copiedEnvironment = yield* ensureEnvironment(copied);
        const copiedStackId = deriveStackId(copiedEnvironment.identity, "default");
        const copiedOwner = yield* acquireControl({ stackId: copiedStackId });
        if (!isControlOwnership(copiedOwner)) throw new Error("expected copied ownership");
        const copiedStack = yield* startManagedStack(manager, {
          workspacePath: copied,
          portDocument: automaticDocument(),
          ownership: copiedOwner,
          lifecycle: "starting",
        });
        yield* releaseLease(copiedStack);

        armed = true;
        const stopping = yield* Effect.forkScoped(stopManagedStack({ workspacePath: copied }));
        yield* Deferred.await(markerSwapped);
        yield* copiedOwner.close;
        const result = yield* Fiber.join(stopping).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) {
          expect(Cause.squash(result.cause)).toMatchObject({
            _tag: "InvalidManagedIdentityError",
          });
        }
        expect((yield* manager.inspectStack(copiedStackId))?.lifecycle).toBe("starting");
      }),
    ).pipe(
      Effect.provide(managerLayer),
      Effect.provide(gatedTransport),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(httpTransportClientLayer),
    );
  });

  it.live("deletes an owned stack when its document path is a directory", () => {
    const { layer, stateRoot, workspace } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const environment = yield* ensureEnvironment(workspace);
        const stackId = deriveStackId(environment.identity, "default");
        const owner = yield* acquireControl({ stackId });
        if (!isControlOwnership(owner)) throw new Error("expected ownership");
        const started = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: automaticDocument(),
          ownership: owner,
          lifecycle: "stopped",
        });
        yield* started.lease.releaseAll;

        const documentPath = yield* managedStackDocumentPathEffect(stateRoot, stackId);
        rmSync(documentPath);
        mkdirSync(documentPath);
        mkdirSync(join(documentPath, "nested"));
        writeFileSync(join(documentPath, "nested", "orphaned"), "corrupt");

        expect(yield* manager.deleteStack(stackId, owner)).toEqual({
          outcome: "removed",
          stackId,
        });
        const stackRoot = (yield* managedStackPathsEffect(stateRoot, stackId)).root;
        expect(existsSync(stackRoot)).toBe(false);
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
        const [apiPort, dbPort] = yield* freePorts(2);
        if (apiPort === undefined || dbPort === undefined) {
          throw new Error("expected interrupted-delete ports");
        }
        const portDocument = exactCoreDocument(apiPort, dbPort);
        const environment = yield* ensureEnvironment(workspace);
        const stackId = deriveStackId(environment.identity, "default");
        const previousOwner = yield* acquireControl({ stackId });
        if (!isControlOwnership(previousOwner)) throw new Error("expected ownership");
        const previous = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument,
          ownership: previousOwner,
        });
        yield* releaseLease(previous);
        const stackPaths = yield* managedStackPathsEffect(stateRoot, stackId);
        const dataPath = join(stackPaths.data, "orphaned");
        mkdirSync(stackPaths.data, { recursive: true });
        writeFileSync(dataPath, "stale");
        yield* manager.recordLifecycle(previousOwner, { stackId, lifecycle: "deleting" });
        yield* previousOwner.close;

        const nextOwner = yield* acquireControl({ stackId });
        if (!isControlOwnership(nextOwner)) throw new Error("expected recovered ownership");
        const restarted = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument,
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
});
