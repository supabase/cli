import { it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  ManagedRuntime,
  PlatformError,
} from "effect";
import { HttpServer } from "effect/unstable/http";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import {
  deriveRepairOwnershipId,
  ManagedStackManager,
  type ManagedStackManagerShape,
  managedStackManagerLayer,
} from "./managed/manager.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import { acquireControl, ControlTransport } from "./managed/control.ts";
import { deriveStackId, ensureEnvironment } from "./managed/environment.ts";
import { controlTransportLayer } from "./platform-node.ts";
import { managedStackDocumentPath, managedStackPaths } from "./managed/paths.ts";
import { Stack } from "./Stack.ts";
import { DaemonServer } from "./DaemonServer.ts";
import { makeRepository } from "../tests/helpers/git-workspace.ts";
import { deleteManagedStack } from "./managed/lifecycle.ts";
import { listStacks as listStackSummaries } from "./discovery.ts";
import {
  automaticDocument,
  cleanupRoots,
  controlStack,
  releaseLease,
  setupManagedManager,
  startWithOwner,
} from "../tests/helpers/managed-manager.ts";

const roots: Array<string> = [];
afterEach(() => cleanupRoots(roots));
const setup = () => setupManagedManager(roots);

const acquireIsolatedCollisionOwner = () =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const stackId = randomBytes(32).toString("hex");
      const collidingStackId = `${stackId.slice(0, 10)}${randomBytes(27).toString("hex")}`;
      const acquisition = yield* acquireControl({ stackId }).pipe(
        Effect.timeout("1 second"),
        Effect.exit,
      );
      if (Exit.isSuccess(acquisition) && acquisition.value._tag === "Owned") {
        return { collidingStackId, ownership: acquisition.value };
      }
    }
    return yield* Effect.fail(new Error("failed to acquire an isolated collision endpoint"));
  });

const acquireIsolatedStackOwner = (workspacePath: string) =>
  Effect.gen(function* () {
    const environment = yield* ensureEnvironment(workspacePath);
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const stackName = `test-${randomBytes(8).toString("hex")}`;
      const stackId = deriveStackId(environment.identity, stackName);
      const acquisition = yield* acquireControl({ stackId }).pipe(
        Effect.timeout("1 second"),
        Effect.exit,
      );
      if (Exit.isSuccess(acquisition) && acquisition.value._tag === "Owned") {
        return { stackName, ownership: acquisition.value };
      }
    }
    return yield* Effect.fail(new Error("failed to acquire an isolated stack endpoint"));
  });

const startWithIsolatedOwner = (
  manager: ManagedStackManagerShape,
  workspacePath: string,
  portDocument: ReturnType<typeof automaticDocument>,
  lifecycle: "stopped" | "running" = "stopped",
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { stackName, ownership } = yield* acquireIsolatedStackOwner(workspacePath);
      const result = yield* manager.startStack({
        workspacePath,
        stackName,
        portDocument,
        ownership,
        lifecycle,
      });
      return { ...result, stackName };
    }),
  );

describe("managed stack recovery journeys", () => {
  it.live("revalidates a copied ordinary workspace after a concurrent first start", () => {
    const root = mkdtempSync(join(tmpdir(), "managed-manager-race-test-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const copied = join(root, "workspace-copy");
    const stateRoot = join(root, "state");
    mkdirSync(workspace);
    const gate = { enabled: true, blocked: false };
    const gatedFileSystemLayer = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const base = yield* FileSystem.FileSystem;
        return {
          ...base,
          readFileString: (path: string, options?: Parameters<typeof base.readFileString>[1]) => {
            if (!gate.enabled || gate.blocked || !path.endsWith("stack.json")) {
              return base.readFileString(path, options);
            }
            gate.blocked = true;
            return Effect.gen(function* () {
              yield* Deferred.succeed(readStarted, void 0);
              yield* Deferred.await(releaseRead);
              return yield* base.readFileString(path, options);
            });
          },
        } satisfies FileSystem.FileSystem;
      }),
    ).pipe(Layer.provide(NodeFileSystem.layer));
    const managerLayer = managedStackManagerLayer({ stateRoot }).pipe(
      Layer.provide(gatedFileSystemLayer),
      Layer.provide(NodePath.layer),
      Layer.provide(gitConfigStoreLayer),
      Layer.provide(controlTransportLayer),
    );
    let readStarted!: Deferred.Deferred<void>;
    let releaseRead!: Deferred.Deferred<void>;
    return Effect.scoped(
      Effect.gen(function* () {
        readStarted = yield* Deferred.make<void>();
        releaseRead = yield* Deferred.make<void>();
        const manager = yield* ManagedStackManager;
        const environment = yield* ensureEnvironment(workspace);
        cpSync(workspace, copied, { recursive: true });
        const stackId = deriveStackId(environment.identity, "default");
        const ownership = yield* acquireControl({ stackId });
        if (ownership._tag !== "Owned") throw new Error("expected stack control ownership");

        const readFiber = yield* Effect.forkScoped(
          manager.readStack({ workspacePath: copied, portDocument: automaticDocument() }),
        );
        yield* Deferred.await(readStarted);
        const startFiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            const started = yield* manager.startStack({
              workspacePath: workspace,
              portDocument: automaticDocument(),
              ownership,
              lifecycle: "stopped",
            });
            yield* started.lease.releaseAll;
          }),
        );
        yield* Fiber.join(startFiber);
        gate.enabled = false;
        yield* Deferred.succeed(releaseRead, void 0);
        const read = yield* Fiber.join(readFiber).pipe(Effect.exit);
        expect(Exit.isFailure(read)).toBe(true);
        if (Exit.isFailure(read)) {
          expect(Cause.squash(read.cause)).toMatchObject({
            _tag: "InvalidManagedIdentityError",
          });
        }
      }),
    ).pipe(
      Effect.provide(managerLayer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });

  it.live("fences start publication while checkout repair is owned", () => {
    const { layer, workspace } = setup();
    return Effect.gen(function* () {
      const baseTransport = yield* ControlTransport;
      const repairRead = yield* Deferred.make<void>();
      let repairEndpointUrl: string | undefined;
      const observedTransport = Layer.succeed(ControlTransport, {
        ...baseTransport,
        read: (endpoint) =>
          Effect.gen(function* () {
            if (endpoint.url === repairEndpointUrl) {
              yield* Deferred.succeed(repairRead, void 0);
            }
            return yield* baseTransport.read(endpoint);
          }),
      });

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* ManagedStackManager;
          const environment = yield* ensureEnvironment(workspace);
          const repairId = deriveRepairOwnershipId(environment.identity);
          const repairOwner = yield* acquireControl({ stackId: repairId });
          if (repairOwner._tag !== "Owned") throw new Error("expected repair ownership");
          repairEndpointUrl = repairOwner.endpoint.url;
          const repairDaemon = ManagedRuntime.make(
            DaemonServer.layerWithShutdown(Effect.void, repairOwner.ownerStatus).pipe(
              Layer.provide(Layer.succeed(Stack, controlStack())),
              Layer.provide(Layer.succeed(HttpServer.HttpServer, repairOwner.server)),
            ),
          );
          yield* Effect.promise(() => repairDaemon.runPromise(DaemonServer));
          const stackOwner = yield* acquireIsolatedStackOwner(workspace);
          const stackId = deriveStackId(environment.identity, stackOwner.stackName);
          const startFiber = yield* manager
            .startStack({
              workspacePath: workspace,
              stackName: stackOwner.stackName,
              portDocument: automaticDocument(),
              ownership: stackOwner.ownership,
            })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(repairRead).pipe(Effect.timeout("1 second"));
          expect(yield* manager.inspectStack(stackId)).toBeUndefined();
          yield* repairOwner.close;
          yield* Effect.promise(() => repairDaemon.dispose());
          const started = yield* Fiber.join(startFiber).pipe(Effect.timeout("2 seconds"));
          expect(started.stack.id).toBe(stackId);
          yield* releaseLease(started);
        }),
      ).pipe(
        Effect.provide(layer),
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(NodePath.layer),
        Effect.provide(gitConfigStoreLayer),
        Effect.provide(observedTransport),
      );
    }).pipe(Effect.provide(controlTransportLayer));
  });

  it.live("rejects a colliding control capability for another stack id", () => {
    const { layer } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const { collidingStackId, ownership } = yield* acquireIsolatedCollisionOwner();
        const rejected = yield* manager
          .allocateManagedPorts(ownership, {
            stackId: collidingStackId,
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

  it.live("repairs a moved workspace without changing stack id or ports", () => {
    const { layer, stateRoot } = setup();
    // Permission bits cannot block writes when tests run as root, so gate the
    // FileSystem seam instead to force the partial-repair failure.
    const blockedWrites = { root: undefined as string | undefined };
    const blockingFileSystemLayer = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const base = yield* FileSystem.FileSystem;
        return {
          ...base,
          writeFileString: (
            path: string,
            data: string,
            options?: Parameters<typeof base.writeFileString>[2],
          ) =>
            blockedWrites.root !== undefined && path.startsWith(blockedWrites.root)
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "writeFileString",
                    pathOrDescriptor: path,
                  }),
                )
              : base.writeFileString(path, data, options),
        } satisfies FileSystem.FileSystem;
      }),
    ).pipe(Layer.provide(NodeFileSystem.layer));
    return Effect.scoped(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), "managed-repair-test-"));
        roots.push(root);
        const repository = makeRepository(root);
        const firstProject = join(repository, "apps", "first");
        const secondProject = join(repository, "apps", "second");
        mkdirSync(firstProject, { recursive: true });
        mkdirSync(secondProject, { recursive: true });
        const manager = yield* ManagedStackManager;
        const original = yield* Effect.scoped(
          startWithIsolatedOwner(manager, firstProject, automaticDocument(), "running"),
        );
        const originalStackName = original.stackName;
        const secondary = yield* Effect.scoped(
          startWithIsolatedOwner(manager, secondProject, automaticDocument(), "stopped"),
        );
        const originalId = original.stack.id;
        const originalPort = original.stack.ports[0]?.port;
        const secondaryId = secondary.stack.id;
        const moved = join(root, "moved");
        renameSync(repository, moved);
        const movedFirstProject = realpathSync(join(moved, "apps", "first"));
        const movedSecondProject = realpathSync(join(moved, "apps", "second"));
        const discovery = yield* manager.discoverWorkspace(movedFirstProject);
        if (discovery.state !== "needsRepair") throw new Error("expected repair");
        const blockedRead = yield* manager
          .readStack({
            workspacePath: movedFirstProject,
            stackName: originalStackName,
            portDocument: automaticDocument(),
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(blockedRead)).toBe(true);
        if (Exit.isFailure(blockedRead)) {
          const blockedError = Cause.squash(blockedRead.cause);
          expect(blockedError).toMatchObject({
            _tag: "ManagedWorkspaceRepairConflictError",
            repairReason: "moved",
          });
          if (blockedError instanceof Error) {
            expect(blockedError.message).toContain("repairWorkspace");
          }
        }
        const deleteBeforeRepair = yield* deleteManagedStack({
          workspacePath: movedFirstProject,
          stackName: originalStackName,
        }).pipe(Effect.exit);
        expect(Exit.isFailure(deleteBeforeRepair)).toBe(true);
        const blockedId = [originalId, secondaryId].sort().at(-1);
        if (blockedId === undefined) throw new Error("expected affected stack");
        const blockedRoot = managedStackPaths(stateRoot, blockedId).root;
        blockedWrites.root = blockedRoot;
        const failed = yield* manager.repairWorkspace(discovery.repair).pipe(Effect.exit);
        blockedWrites.root = undefined;
        expect(Exit.isFailure(failed)).toBe(true);
        const firstUpdatedId = [originalId, secondaryId].sort().at(0);
        if (firstUpdatedId === undefined) throw new Error("expected affected stack");
        const partial = yield* manager.inspectStack(firstUpdatedId);
        const partialExpectedPath =
          partial?.identity.localProjectKey === "apps/first"
            ? movedFirstProject
            : movedSecondProject;
        expect(partial?.workspace.path).toBe(partialExpectedPath);
        const stillNeedsRepair = yield* manager.discoverWorkspace(movedFirstProject);
        expect(stillNeedsRepair.state).toBe("needsRepair");
        const repaired = yield* manager.repairWorkspace(discovery.repair);
        expect(repaired.state).toBe("ready");
        const stack = yield* manager.inspectStack(originalId);
        expect(stack?.id).toBe(originalId);
        expect(stack?.lifecycle).toBe("failed");
        expect(stack?.runtime).toBeUndefined();
        expect(stack?.ports[0]?.port).toBe(originalPort);
        expect(stack?.workspace.path).toBe(movedFirstProject);
        const repairedSecondary = yield* manager.inspectStack(secondaryId);
        expect(repairedSecondary?.workspace.path).toBe(movedSecondProject);
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provide(blockingFileSystemLayer),
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

  it.live("treats unsupported Git metadata as no managed stacks on read-only listing", () => {
    const { layer, stateRoot, workspace } = setup();
    mkdirSync(join(workspace, ".git"));
    return listStackSummaries({ cacheRoot: stateRoot, projectDir: workspace }).pipe(
      Effect.tap((summaries) => Effect.sync(() => expect(summaries).toEqual([]))),
      Effect.provide(layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });
});
