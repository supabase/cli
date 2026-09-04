// oxlint-disable effecttsgo/multiple-effect-provide, effecttsgo/node-builtin-import -- Project-manager tests use native temporary paths for filesystem-backed integration fixtures; manager dependencies are staged to satisfy dependent transport layers.
import { it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { ManagedStackManager } from "./managed/manager.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import { acquireControl, ControlTransport, isControlOwnership } from "./managed/control.ts";
import { deriveStackId, ensureEnvironment } from "./managed/environment.ts";
import { controlTransportLayer } from "./platform-node.ts";
import { listStacks as listStackSummaries, resolveStackSummary } from "./discovery.ts";
import { git, makeRepository } from "../tests/helpers/git-workspace.ts";
import {
  automaticDocument,
  cleanupRoots,
  setupManagedManager,
  startManagedStack,
  startWithOwner,
} from "../tests/helpers/managed-manager.ts";

const roots: Array<string> = [];
afterEach(() => cleanupRoots(roots));
const setup = () => setupManagedManager(roots);

describe("managed stack projects journeys", () => {
  it.live("rejects copied ordinary workspace identity until the original path is moved", () => {
    const { layer, workspace } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ManagedStackManager;
        const environment = yield* ensureEnvironment(workspace);
        const stackId = deriveStackId(environment.identity, "default");
        const ownership = yield* acquireControl({ stackId, maintenanceOperation: "update" });
        if (!isControlOwnership(ownership)) throw new Error("expected stack control ownership");
        const initial = yield* startManagedStack(manager, {
          workspacePath: workspace,
          stackName: "default",
          portDocument: automaticDocument(),
          ownership,
          lifecycle: "stopped",
        });
        yield* initial.lease.releaseAll;

        const copied = join(workspace, "..", "workspace-copy");
        cpSync(workspace, copied, { recursive: true });
        const copiedDiscovery = yield* manager.discoverWorkspace(copied).pipe(Effect.exit);
        expect(Exit.isFailure(copiedDiscovery)).toBe(true);
        if (Exit.isFailure(copiedDiscovery)) {
          const error = Cause.squash(copiedDiscovery.cause);
          expect(error).toMatchObject({ _tag: "InvalidManagedIdentityError" });
          if (error instanceof Error) {
            expect(error.message).toContain("Delete");
            expect(error.message).toContain(".supabase/identity.json");
          }
        }
        const copiedEnsure = yield* manager.ensureWorkspace(copied).pipe(Effect.exit);
        expect(Exit.isFailure(copiedEnsure)).toBe(true);
        if (Exit.isFailure(copiedEnsure)) {
          expect(Cause.squash(copiedEnsure.cause)).toMatchObject({
            _tag: "InvalidManagedIdentityError",
          });
        }

        const copiedStart = yield* startManagedStack(manager, {
          workspacePath: copied,
          stackName: "default",
          portDocument: automaticDocument(),
          ownership,
          lifecycle: "stopped",
        }).pipe(Effect.exit);
        expect(Exit.isFailure(copiedStart)).toBe(true);
        if (Exit.isFailure(copiedStart)) {
          const error = Cause.squash(copiedStart.cause);
          expect(error).toMatchObject({ _tag: "InvalidManagedIdentityError" });
          if (error instanceof Error) {
            expect(error.message).toContain("Delete");
            expect(error.message).toContain(".supabase/identity.json");
          }
        }

        git(workspace, "init", "-q", "-b", "main");
        const copiedAfterOriginalGit = yield* manager.discoverWorkspace(copied);
        expect(copiedAfterOriginalGit.state).toBe("ready");
        rmSync(join(workspace, ".git"), { recursive: true, force: true });

        rmSync(copied, { recursive: true, force: true });
        renameSync(workspace, copied);
        const movedDiscovery = yield* manager.discoverWorkspace(copied);
        expect(movedDiscovery.state).toBe("ready");
        writeFileSync(workspace, "stale workspace path");
        const moved = yield* startManagedStack(manager, {
          workspacePath: copied,
          stackName: "default",
          portDocument: automaticDocument(),
          ownership,
          lifecycle: "stopped",
        });
        expect(moved.stack.id).toBe(stackId);
        expect(moved.stack.workspace.path).toBe(realpathSync(copied));
        expect((yield* manager.inspectStack(stackId))?.workspace.path).toBe(realpathSync(copied));
        yield* moved.lease.releaseAll;
      }),
    ).pipe(
      Effect.provide(layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });

  it.live("rejects empty and ASCII-control stack names before resolving a stack", () => {
    const { layer, workspace } = setup();
    return Effect.gen(function* () {
      const manager = yield* ManagedStackManager;
      for (const stackName of ["", "bad\nname"]) {
        const exit = yield* manager
          .readStack({ workspacePath: workspace, stackName, portDocument: automaticDocument() })
          .pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({
            _tag: "InvalidManagedStackNameError",
          });
        }
      }
    }).pipe(
      Effect.provide(layer),
      Effect.provide(NodeFileSystem.layer),
      Effect.provide(NodePath.layer),
      Effect.provide(gitConfigStoreLayer),
      Effect.provide(controlTransportLayer),
    );
  });

  it.live("lets a concurrent start own the endpoint while status checks liveness", () => {
    const { layer, stateRoot, workspace } = setup();
    return Effect.gen(function* () {
      const baseTransport = yield* ControlTransport;
      const readStarted = yield* Deferred.make<void>();
      const continueRead = yield* Deferred.make<void>();
      // Hold only the status probe's first read in flight. Later reads (the
      // concurrent acquire scans its endpoint candidates before binding) must
      // pass through, mirroring the real transport's bounded read timeout.
      let gateReads = false;
      let gatedRead = false;
      const gatedTransport = Layer.succeed(ControlTransport, {
        ...baseTransport,
        read: (endpoint) =>
          Effect.suspend(() => {
            if (!gateReads || gatedRead) return baseTransport.read(endpoint);
            gatedRead = true;
            return Effect.gen(function* () {
              yield* Deferred.succeed(readStarted, void 0);
              yield* Deferred.await(continueRead);
              return yield* baseTransport.read(endpoint);
            });
          }),
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
              controlProtocol: "supabase-stack-control",
              controlProtocolVersion: 1,
              ownershipId: stackId,
              ownerSessionId: "projects-test-session",
              kind: "supervisor",
              state: "running",
              ready: true,
              daemonCliVersion: "test",
            },
          });
          if (!isControlOwnership(owner)) throw new Error("status probe took control ownership");
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

  it.live("isolates default stacks in sibling nested projects", () => {
    const { layer, stateRoot } = setup();
    return Effect.scoped(
      Effect.gen(function* () {
        const root = mkdtempSync(join(tmpdir(), "managed-nested-projects-test-"));
        roots.push(root);
        const repository = makeRepository(root);
        const firstProject = join(repository, "apps", "first");
        const secondProject = join(repository, "apps", "second");
        mkdirSync(firstProject, { recursive: true });
        mkdirSync(secondProject, { recursive: true });
        mkdirSync(join(firstProject, "supabase"));
        mkdirSync(join(secondProject, "supabase"));
        writeFileSync(join(firstProject, "supabase", "config.toml"), 'project_id = "remote"\n');
        writeFileSync(join(secondProject, "supabase", "config.toml"), 'project_id = "remote"\n');
        const firstAlias = join(root, "first-project-link");
        symlinkSync(firstProject, firstAlias, "dir");
        const manager = yield* ManagedStackManager;
        const startAndClose = (project: string) =>
          Effect.scoped(
            startWithOwner(manager, project, automaticDocument()).pipe(
              Effect.map((result) => result.stack),
            ),
          );
        const first = yield* startAndClose(firstProject);
        const second = yield* startAndClose(secondProject);
        if (first === undefined || second === undefined) {
          throw new Error("expected both nested project stacks");
        }
        const firstPort = first.ports.find((assignment) => assignment.key === "api.port")?.port;
        const secondPort = second.ports.find((assignment) => assignment.key === "api.port")?.port;
        expect(first.id).not.toBe(second.id);
        expect(firstPort).toBeDefined();
        expect(secondPort).toBeDefined();
        expect(firstPort).not.toBe(secondPort);
        expect(first.identity.localProjectKey).toBe("apps/first");
        expect(second.identity.localProjectKey).toBe("apps/second");
        expect(first.workspace.path).toBe(realpathSync(firstProject));
        expect(second.workspace.path).toBe(realpathSync(secondProject));
        const firstListing = yield* listStackSummaries({
          cacheRoot: stateRoot,
          projectDir: firstAlias,
        });
        const secondListing = yield* listStackSummaries({
          cacheRoot: stateRoot,
          projectDir: secondProject,
        });
        expect(firstListing).toHaveLength(1);
        expect(secondListing).toHaveLength(1);
        expect(firstListing[0]?.name).toBe("default");
        expect(secondListing[0]?.name).toBe("default");
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
