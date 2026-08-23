import { it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Cause, Effect, Exit } from "effect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { ManagedStackManager } from "./managed/manager.ts";
import { ManagedExactPortOccupiedError } from "./managed/model.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import {
  acquireControl,
  CONTROL_PORT_RANGE,
  controlEndpoint,
  isControlOwnership,
} from "./managed/control.ts";
import { controlTransportLayer } from "./platform-node.ts";
import { reservePortSet } from "./PortAllocator.ts";
import {
  acquireWorkspaceControl,
  automaticDocument,
  automaticRuntimeDocument,
  cleanupRoots,
  closeExternal,
  exactCoreDocument,
  exactDocument,
  freePort,
  freePorts,
  listenExternal,
  releaseLease,
  setupManagedManager,
  startManagedStack,
} from "../tests/helpers/managed-manager.ts";

const roots: Array<string> = [];
afterEach(() => cleanupRoots(roots));
const setup = () => setupManagedManager(roots);

describe("managed stack ports journeys", () => {
  it.live("retains the same automatic ports while stopped", () => {
    const { layer, workspace: base } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const { workspace, ownership } = yield* acquireWorkspaceControl(base);
        if (!isControlOwnership(ownership)) throw new Error("expected stack control ownership");
        const first = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: { activeFields: ["apiPort", "dbPort"], document: {} },
          ownership,
        });
        yield* releaseLease(first);
        const second = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: {
            activeFields: [],
            disabledFields: ["apiPort", "dbPort"],
            document: {},
          },
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

  it.live("reserves exact durable and automatic runtime ports through one lease", () => {
    const { layer, workspace: base } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const apiPort = yield* freePort();
        const { workspace, ownership } = yield* acquireWorkspaceControl(base);
        if (!isControlOwnership(ownership)) throw new Error("expected ownership");
        const started = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: {
            activeFields: ["apiPort", "dbPort", "authPort"],
            document: { api: { port: apiPort } },
          },
          ownership,
        });
        const fields = ["apiPort", "dbPort", "authPort"] as const;
        yield* started.lease.release(fields);
        yield* started.lease.reserve(fields);
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

  it.live("allows stopped exact siblings and rejects a live owner", () => {
    const { layer, workspace: base } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const port = yield* freePort();
        const firstOwner = yield* acquireWorkspaceControl(base, "first");
        if (!isControlOwnership(firstOwner.ownership)) throw new Error("expected first ownership");
        const first = yield* startManagedStack(manager, {
          workspacePath: firstOwner.workspace,
          portDocument: exactDocument("apiPort", port),
          ownership: firstOwner.ownership,
        });
        yield* releaseLease(first);
        const secondOwner = yield* acquireWorkspaceControl(base, "second");
        if (!isControlOwnership(secondOwner.ownership))
          throw new Error("expected second ownership");
        const second = yield* startManagedStack(manager, {
          workspacePath: secondOwner.workspace,
          portDocument: exactDocument("apiPort", port),
          ownership: secondOwner.ownership,
        });
        yield* releaseLease(second);
        const liveOwner = yield* acquireWorkspaceControl(base, "live");
        if (!isControlOwnership(liveOwner.ownership)) throw new Error("expected live ownership");
        const live = yield* startManagedStack(manager, {
          workspacePath: liveOwner.workspace,
          portDocument: exactDocument("apiPort", port),
          ownership: liveOwner.ownership,
          lifecycle: "running",
        });
        const rejectedOwner = yield* acquireWorkspaceControl(base, "rejected");
        if (!isControlOwnership(rejectedOwner.ownership))
          throw new Error("expected rejected ownership");
        const rejected = yield* startManagedStack(manager, {
          workspacePath: rejectedOwner.workspace,
          portDocument: exactDocument("apiPort", port),
          ownership: rejectedOwner.ownership,
        }).pipe(Effect.exit);
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

  it.live("allows an unused exact API port inside the control range", () => {
    const { layer, workspace: base } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const { workspace, ownership } = yield* acquireWorkspaceControl(base);
        if (!isControlOwnership(ownership)) throw new Error("expected stack ownership");
        const port = ownership.endpoint.port === 15_432 ? 15_433 : 15_432;
        const started = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: exactDocument("apiPort", port),
          ownership,
        });
        expect(started.stack.ports).toEqual(
          expect.arrayContaining([{ key: "api.port", port, intent: "exact" }]),
        );
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

  it.live("rejects an exact API port matching a persisted stack control endpoint", () => {
    const { layer, workspace: base } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const {
          workspace: otherWorkspace,
          stackId: otherStackId,
          ownership: otherOwnership,
        } = yield* acquireWorkspaceControl(base, "other");
        if (!isControlOwnership(otherOwnership)) throw new Error("expected other stack ownership");
        const other = yield* startManagedStack(manager, {
          workspacePath: otherWorkspace,
          portDocument: automaticDocument(),
          ownership: otherOwnership,
          lifecycle: "stopped",
        });
        yield* releaseLease(other);
        yield* otherOwnership.close;
        const otherEndpoint = yield* controlEndpoint(otherStackId);

        const { workspace, ownership } = yield* acquireWorkspaceControl(base);
        if (!isControlOwnership(ownership)) throw new Error("expected stack ownership");
        const rejected = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: exactDocument("apiPort", otherEndpoint.port),
          ownership,
        }).pipe(Effect.exit);

        expect(Exit.isFailure(rejected)).toBe(true);
        if (Exit.isFailure(rejected)) {
          expect(Cause.squash(rejected.cause)).toMatchObject({
            _tag: "ManagedExactPortOccupiedError",
            key: "api.port",
            port: otherEndpoint.port,
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

  it.live("attributes an exact API port collision with an external listener", () => {
    const { layer, workspace: base } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const port = yield* freePort();
        const external = yield* Effect.acquireRelease(
          Effect.promise(() => listenExternal(port)),
          (server) => Effect.promise(() => closeExternal(server)),
        );
        expect(external.listening).toBe(true);

        const { workspace, ownership } = yield* acquireWorkspaceControl(base);
        if (!isControlOwnership(ownership)) throw new Error("expected stack ownership");
        const rejected = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: exactDocument("apiPort", port),
          ownership,
        }).pipe(Effect.exit);

        expect(Exit.isFailure(rejected)).toBe(true);
        if (Exit.isFailure(rejected)) {
          expect(Cause.squash(rejected.cause)).toMatchObject({
            _tag: "ManagedExactPortOccupiedError",
            key: "api.port",
            port,
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

  it.live("keeps automatic ports exclusive while stopped", () => {
    const { layer } = setup();
    const root = mkdtempSync(join(tmpdir(), "managed-auto-test-"));
    roots.push(root);
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const [apiPort, dbPort] = yield* freePorts(2);
        if (apiPort === undefined || dbPort === undefined) {
          throw new Error("expected isolated automatic ports");
        }
        const {
          workspace: firstWorkspace,
          stackId,
          ownership,
        } = yield* acquireWorkspaceControl(root, "first");
        if (!isControlOwnership(ownership)) throw new Error("expected ownership");
        const exact = yield* startManagedStack(manager, {
          workspacePath: firstWorkspace,
          portDocument: exactCoreDocument(apiPort, dbPort),
          ownership,
        });
        yield* releaseLease(exact);
        const first = yield* startManagedStack(manager, {
          workspacePath: firstWorkspace,
          portDocument: automaticRuntimeDocument(),
          ownership,
        });
        yield* releaseLease(first);
        expect(
          first.stack.ports.every(
            ({ port }) => port < CONTROL_PORT_RANGE.min || port > CONTROL_PORT_RANGE.max,
          ),
        ).toBe(true);
        const stalePort = ownership.endpoint.port === 15_432 ? 15_433 : 15_432;
        const stale = yield* manager
          .allocateManagedPorts(ownership, {
            stackId,
            portDocument: automaticRuntimeDocument(),
            persisted: [{ key: "api.port", port: stalePort, intent: "automatic" }],
          })
          .pipe(Effect.exit);
        if (Exit.isSuccess(stale)) yield* stale.value.lease.releaseAll;
        expect(Exit.isFailure(stale)).toBe(true);
        if (Exit.isFailure(stale)) {
          expect(Cause.squash(stale.cause)).toMatchObject({
            _tag: "ManagedPortAllocationError",
            fields: ["apiPort"],
          });
        }
        const inactiveStale = yield* manager
          .allocateManagedPorts(ownership, {
            stackId,
            portDocument: {
              activeFields: ["dbPort"],
              disabledFields: ["apiPort"],
              document: {},
            },
            persisted: [{ key: "api.port", port: stalePort, intent: "automatic" }],
          })
          .pipe(Effect.exit);
        if (Exit.isSuccess(inactiveStale)) yield* inactiveStale.value.lease.releaseAll;
        expect(Exit.isFailure(inactiveStale)).toBe(true);
        if (Exit.isFailure(inactiveStale)) {
          expect(Cause.squash(inactiveStale.cause)).toMatchObject({
            _tag: "ManagedPortAllocationError",
            fields: ["apiPort"],
          });
        }
        const firstPort = first.stack.ports[0]?.port;
        if (firstPort === undefined) throw new Error("expected automatic port");
        const external = yield* reservePortSet([
          { field: "apiPort", selection: { kind: "exact", port: firstPort } },
        ]);
        const restart = yield* startManagedStack(manager, {
          workspacePath: firstWorkspace,
          portDocument: automaticRuntimeDocument(),
          ownership,
        }).pipe(Effect.exit);
        expect(Exit.isFailure(restart)).toBe(true);
        if (Exit.isFailure(restart)) {
          expect(Cause.squash(restart.cause)).toMatchObject({
            _tag: "ManagedPortAllocationError",
          });
        }
        yield* external.releaseAll;
        const { workspace: secondWorkspace, ownership: secondOwnership } =
          yield* acquireWorkspaceControl(root, "second");
        if (!isControlOwnership(secondOwnership)) throw new Error("expected second ownership");
        const second = yield* startManagedStack(manager, {
          workspacePath: secondWorkspace,
          portDocument: automaticRuntimeDocument(),
          ownership: secondOwnership,
        });
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
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const [original, dbPort, changed] = yield* freePorts(3);
        if (original === undefined || dbPort === undefined || changed === undefined) {
          throw new Error("expected drift ports");
        }
        const {
          workspace,
          stackId,
          ownership: initialOwnership,
        } = yield* acquireWorkspaceControl(root);
        if (!isControlOwnership(initialOwnership)) throw new Error("expected ownership");
        const running = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: exactCoreDocument(original, dbPort),
          ownership: initialOwnership,
          lifecycle: "running",
        });
        const status = yield* manager.readStack({
          workspacePath: workspace,
          portDocument: exactCoreDocument(changed, dbPort),
        });
        expect(status?.drift).toHaveLength(1);
        const missingAssignment = yield* manager.readStack({
          workspacePath: workspace,
          portDocument: automaticDocument("studioPort"),
        });
        const missingDrift = missingAssignment?.drift?.find((drift) => drift.key === "studio.port");
        expect(missingDrift).toBeDefined();
        expect(missingDrift?.actualPort).toBeUndefined();
        yield* releaseLease(running);
        yield* manager.recordLifecycle(initialOwnership, { stackId, lifecycle: "stopped" });
        yield* initialOwnership.close;
        const ownership = yield* acquireControl({ stackId });
        if (!isControlOwnership(ownership)) throw new Error("expected ownership");
        const stopped = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: exactCoreDocument(changed, dbPort),
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
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const port = yield* freePort();
        const { workspace, ownership } = yield* acquireWorkspaceControl(root);
        if (!isControlOwnership(ownership)) throw new Error("expected ownership");
        const first = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: exactDocument("studioPort", port),
          ownership,
        });
        yield* releaseLease(first);
        const disabled = yield* startManagedStack(manager, {
          workspacePath: workspace,
          portDocument: { activeFields: [], disabledFields: ["studioPort"], document: {} },
          ownership,
        });
        expect(
          disabled.stack.ports.filter((assignment) => assignment.key === "studio.port"),
        ).toEqual([{ key: "studio.port", port, intent: "exact" }]);
        yield* releaseLease(disabled);
        const removed = yield* startManagedStack(manager, {
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
});
