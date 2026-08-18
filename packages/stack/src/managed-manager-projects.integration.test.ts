import { it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "vitest";
import { ManagedStackManager } from "./managed/manager.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import { acquireControl, ControlTransport } from "./managed/control.ts";
import { controlTransportLayer } from "./platform-node.ts";
import { listStacks as listStackSummaries, resolveStackSummary } from "./discovery.ts";
import { makeRepository } from "../tests/helpers/git-workspace.ts";
import {
  automaticDocument,
  cleanupRoots,
  setupManagedManager,
  startWithOwner,
} from "../tests/helpers/managed-manager.ts";

const roots: Array<string> = [];
afterEach(() => cleanupRoots(roots));
const setup = () => setupManagedManager(roots);

describe("managed stack projects journeys", () => {
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
