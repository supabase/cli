import { it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Cause, Effect, Exit } from "effect";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { ManagedStackManager, managedStackManagerLayer } from "./managed/manager.ts";
import type { ManagedStackStartResult } from "./managed/manager.ts";
import { ManagedExactPortOccupiedError } from "./managed/model.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import { acquireControl } from "./managed/control.ts";
import { deriveStackId, ensureEnvironment } from "./managed/environment.ts";
import { controlTransportLayer } from "./platform-node.ts";
import { reservePortSet } from "./PortAllocator.ts";
import { managedStackDocumentPath, managedStackPaths } from "./managed/paths.ts";
import { git, makeRepository } from "../tests/helpers/git-workspace.ts";
import type { ManagedPortIntentDocument } from "./managed/model.ts";
import type { ManagedStackManagerShape } from "./managed/manager.ts";

const roots: Array<string> = [];

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

const automaticDocument = (field: "apiPort" | "studioPort" = "apiPort") =>
  ({
    activeFields: [field],
    document: {},
  }) as const;

const exactDocument = (field: "apiPort" | "studioPort", port: number) =>
  ({
    activeFields: [field],
    document: field === "apiPort" ? { api: { port } } : { studio: { port } },
  }) as const;

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
) =>
  Effect.gen(function* () {
    const environment = yield* ensureEnvironment(workspacePath);
    const stackId = deriveStackId(environment.identity, "default");
    const ownership = yield* acquireControl({ stackId });
    if (ownership._tag !== "Owned") throw new Error("expected stack control ownership");
    return yield* manager.resolveStack({
      operation: "start",
      workspacePath,
      portDocument,
      ownership,
      lifecycle,
    });
  });

const releaseLease = (result: ManagedStackStartResult): Effect.Effect<void> =>
  result.outcome === "allocated" ? result.lease.releaseAll : Effect.void;

describe("managed stack journeys", () => {
  it.live("restarts the same environment with the same automatic ports", () => {
    const { layer, workspace } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const environment = yield* ensureEnvironment(workspace);
        const stackId = deriveStackId(environment.identity, "default");
        const ownership = yield* acquireControl({ stackId });
        if (ownership._tag !== "Owned") throw new Error("expected stack control ownership");
        const first = yield* manager.resolveStack({
          operation: "start",
          workspacePath: workspace,
          portDocument: { activeFields: ["apiPort"], document: {} },
          ownership,
        });
        yield* releaseLease(first);
        const second = yield* manager.resolveStack({
          operation: "start",
          workspacePath: workspace,
          portDocument: { activeFields: ["apiPort"], document: {} },
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

  it.live("runs sibling worktrees with independent automatic ports", () => {
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
        const first = yield* startWithOwner(manager, firstWorkspace, automaticDocument());
        const second = yield* startWithOwner(manager, secondWorkspace, automaticDocument());
        expect(first.stack.id).not.toBe(second.stack.id);
        expect(first.stack.ports[0]?.port).not.toBe(second.stack.ports[0]?.port);
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
        const first = yield* manager.resolveStack({
          operation: "start",
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
          .resolveStack({
            operation: "start",
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
        const running = yield* manager.resolveStack({
          operation: "start",
          workspacePath: workspace,
          portDocument: exactDocument("apiPort", original),
          ownership: initialOwnership,
          lifecycle: "running",
        });
        const status = yield* manager.resolveStack({
          operation: "status",
          workspacePath: workspace,
          portDocument: exactDocument("apiPort", changed),
        });
        expect(status?.drift).toHaveLength(1);
        yield* releaseLease(running);
        yield* manager.recordLifecycle(initialOwnership, { stackId, lifecycle: "stopped" });
        yield* initialOwnership.close;
        const ownership = yield* acquireControl({ stackId });
        if (ownership._tag !== "Owned") throw new Error("expected ownership");
        const stopped = yield* manager.resolveStack({
          operation: "start",
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
        const first = yield* manager.resolveStack({
          operation: "start",
          workspacePath: workspace,
          portDocument: exactDocument("studioPort", port),
          ownership,
        });
        yield* releaseLease(first);
        const disabled = yield* manager.resolveStack({
          operation: "start",
          workspacePath: workspace,
          portDocument: { activeFields: [], disabledFields: ["studioPort"], document: {} },
          ownership,
        });
        expect(disabled.stack.ports).toEqual([{ key: "studio.port", port, intent: "exact" }]);
        yield* releaseLease(disabled);
        const removed = yield* manager.resolveStack({
          operation: "start",
          workspacePath: workspace,
          portDocument: { activeFields: [], document: {} },
          ownership,
        });
        expect(removed.stack.ports).toEqual([{ key: "studio.port", port, intent: "automatic" }]);
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

  it.live("repairs a moved workspace without changing stack id or ports", () => {
    const { layer } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), "managed-repair-test-"));
        roots.push(root);
        const repository = makeRepository(root);
        const manager = yield* ManagedStackManager;
        const original = yield* Effect.scoped(
          startWithOwner(manager, repository, automaticDocument()),
        );
        const originalId = original.stack.id;
        const originalPort = original.stack.ports[0]?.port;
        const moved = join(root, "moved");
        renameSync(repository, moved);
        const discovery = yield* manager.discoverWorkspace(moved);
        if (discovery.state !== "needsRepair") throw new Error("expected repair");
        const repaired = yield* manager.repairWorkspace(discovery.repair);
        expect(repaired.state).toBe("healthy");
        const stack = yield* manager.inspectStack(originalId);
        expect(stack?.id).toBe(originalId);
        expect(stack?.ports[0]?.port).toBe(originalPort);
        expect(stack?.workspace.path).toBe(repaired.path);
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
