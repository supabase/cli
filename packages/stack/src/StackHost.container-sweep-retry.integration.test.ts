import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Path, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as StackNamespace from "./StackNamespace.ts";
import * as Owner from "./Owner.ts";
import type { EngineTarget } from "./runtime/Container.ts";
import { NativeRuntimeRootBase, nativeRuntimeRootPath } from "./runtime/postgres-user.ts";

const stateFor = (root: string) =>
  Layer.build(StackNamespace.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, StackNamespace.Service)),
  );

const containerId = "claimed0000000000000000000000000001";

/** Resolved once, like an owner's own startup would, and pinned for the whole test. */
const engineTarget: EngineTarget = { engine: "docker", argv: [], daemonId: "current-daemon" };

it.live(
  "retains a claim when the engine is unreachable during destroy, and finishes it once the engine recovers",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-container-sweep-retry-" });
        const state = yield* stateFor(`${root}/state`);
        const saved = {
          id: "stack",
          runtime: "docker" as const,
          identity: { projectRoot: root, branchContext: "main", stackName: "sweep-retry" },
          instances: [],
          lifetime: "detached" as const,
          composition: { members: [], dependencies: [] },
          ports: [],
        };
        yield* state.save(saved);
        // A now-dead owner already claimed this container before being interrupted. Recorded
        // against the daemon this reconcile run will later match, once it recovers.
        yield* state.claim(saved.id, {
          kind: "container",
          id: containerId,
          daemonId: "current-daemon",
        });
        let engineReachable = false;
        let rmCalls = 0;
        const engine = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command) || command.command !== "docker")
            return Effect.die("Unexpected child process command");
          const isClaimRemoval = command.args[0] === "rm" && command.args.includes(containerId);
          if (isClaimRemoval) rmCalls++;
          const fail = isClaimRemoval && !engineReachable;
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(0),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(fail ? 1 : 0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: fail
                ? Stream.succeed(
                    new TextEncoder().encode(
                      "Cannot connect to the Docker daemon at tcp://127.0.0.1:1. Is the docker daemon running?",
                    ),
                  )
                : Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            }),
          );
        });
        const ownerLayer = Owner.layer({
          saved,
          root: `${root}/data`,
          cacheRoot: `${root}/cache`,
          engineTarget,
        }).pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(StackNamespace.Service, state),
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, engine),
            ),
          ),
        );
        const firstOwner = yield* Layer.build(ownerLayer).pipe(
          Effect.map((context) => Context.get(context, Owner.Service)),
        );

        const firstAttempt = yield* firstOwner.namespace.destroy.pipe(Effect.exit);
        expect(firstAttempt._tag).toBe("Failure");
        expect(rmCalls).toBe(1);
        expect(yield* state.read(saved.id)).toBeDefined();
        expect((yield* state.readClaims(saved.id)).map((claim) => claim.id)).toEqual([containerId]);

        // The engine is reachable again: a later acquisition's reconcile finishes the cleanup.
        engineReachable = true;
        const retryOwner = yield* Layer.build(ownerLayer).pipe(
          Effect.map((context) => Context.get(context, Owner.Service)),
        );
        yield* retryOwner.namespace.destroy;
        expect(rmCalls).toBe(2);
        expect(yield* state.read(saved.id)).toBeUndefined();
        expect(yield* state.readClaims(saved.id)).toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live(
  "removes a claimed directory left behind under /tmp and unclaims it, for a native stack with no engine",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-directory-sweep-" });
        const state = yield* stateFor(`${root}/state`);
        const saved = {
          id: "stack",
          runtime: "native" as const,
          identity: { projectRoot: root, branchContext: "main", stackName: "directory-sweep" },
          instances: [],
          lifetime: "detached" as const,
          composition: { members: [], dependencies: [] },
          ports: [],
        };
        yield* state.save(saved);
        // A now-dead owner claimed this short-socket directory, nested under the native runtime
        // root, before being killed; not scoped, since the reconcile under test is itself the one
        // that removes it.
        const runtimeRootBase = yield* fs.makeTempDirectoryScoped({
          prefix: "stack-directory-sweep-runtime-root-",
        });
        const runtimeRoot = nativeRuntimeRootPath(path, runtimeRootBase, process.getuid?.() ?? 0);
        const socketDirectory = path.join(runtimeRoot, "pg-leftover");
        yield* fs.makeDirectory(socketDirectory, { recursive: true, mode: 0o700 });
        yield* fs.writeFileString(`${socketDirectory}/pg_hba.conf`, "local all all trust\n");
        yield* state.claim(saved.id, { kind: "directory", id: socketDirectory });
        const ownerLayer = Owner.layer({
          saved,
          root: `${root}/data`,
          cacheRoot: `${root}/cache`,
        }).pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(StackNamespace.Service, state),
              Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make(() => Effect.die("Unexpected child process command")),
              ),
            ),
          ),
          Layer.provide(Layer.succeed(NativeRuntimeRootBase, runtimeRootBase)),
        );
        const owner = yield* Layer.build(ownerLayer).pipe(
          Effect.map((context) => Context.get(context, Owner.Service)),
        );
        yield* owner.namespace.destroy;
        expect(yield* fs.exists(socketDirectory)).toBe(false);
        expect(yield* state.readClaims(saved.id)).toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live(
  "keeps and reports a claimed directory that resolves outside every owned root, for a native stack with no engine",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "stack-directory-sweep-outside-",
        });
        const state = yield* stateFor(`${root}/state`);
        const saved = {
          id: "stack",
          runtime: "native" as const,
          identity: {
            projectRoot: root,
            branchContext: "main",
            stackName: "directory-sweep-outside",
          },
          instances: [],
          lifetime: "detached" as const,
          composition: { members: [], dependencies: [] },
          ports: [],
        };
        yield* state.save(saved);
        // A foreign directory under neither the data root nor the native runtime root: never ours
        // by location, however it got its name, so recovery must leave it alone.
        const foreign = yield* fs.makeTempDirectoryScoped({
          prefix: "stack-directory-sweep-foreign-",
        });
        yield* fs.writeFileString(`${foreign}/marker`, "not ours\n");
        yield* state.claim(saved.id, { kind: "directory", id: foreign });
        const ownerLayer = Owner.layer({
          saved,
          root: `${root}/data`,
          cacheRoot: `${root}/cache`,
        }).pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(StackNamespace.Service, state),
              Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make(() => Effect.die("Unexpected child process command")),
              ),
            ),
          ),
        );
        const owner = yield* Layer.build(ownerLayer).pipe(
          Effect.map((context) => Context.get(context, Owner.Service)),
        );
        const failure = yield* owner.namespace.destroy.pipe(Effect.flip);
        expect(failure.message).toContain(`directory ${foreign} (daemon unknown)`);
        expect(yield* fs.exists(foreign)).toBe(true);
        expect(yield* state.read(saved.id)).toBeDefined();
        expect((yield* state.readClaims(saved.id)).map((claim) => claim.id)).toEqual([foreign]);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live(
  "keeps and reports a claim nested under a runtime root a foreign uid could have taken over",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "stack-directory-sweep-takeover-",
        });
        const state = yield* stateFor(`${root}/state`);
        const saved = {
          id: "stack",
          runtime: "native" as const,
          identity: {
            projectRoot: root,
            branchContext: "main",
            stackName: "directory-sweep-takeover",
          },
          instances: [],
          lifetime: "detached" as const,
          composition: { members: [], dependencies: [] },
          ports: [],
        };
        yield* state.save(saved);
        // Tests can't create another uid's files, so a group/world-writable leaf stands in for one
        // recreated by a foreign uid after the original was removed.
        const runtimeRootBase = yield* fs.makeTempDirectoryScoped({
          prefix: "stack-directory-sweep-takeover-base-",
        });
        const runtimeRoot = nativeRuntimeRootPath(path, runtimeRootBase, process.getuid?.() ?? 0);
        const claimed = path.join(runtimeRoot, "pg-claimed");
        yield* fs.makeDirectory(claimed, { recursive: true });
        yield* fs.chmod(runtimeRoot, 0o777);
        yield* fs.writeFileString(`${claimed}/marker`, "not ours\n");
        yield* state.claim(saved.id, { kind: "directory", id: claimed });
        const ownerLayer = Owner.layer({
          saved,
          root: `${root}/data`,
          cacheRoot: `${root}/cache`,
        }).pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(StackNamespace.Service, state),
              Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make(() => Effect.die("Unexpected child process command")),
              ),
            ),
          ),
          Layer.provide(Layer.succeed(NativeRuntimeRootBase, runtimeRootBase)),
        );
        const owner = yield* Layer.build(ownerLayer).pipe(
          Effect.map((context) => Context.get(context, Owner.Service)),
        );
        const failure = yield* owner.namespace.destroy.pipe(Effect.flip);
        expect(failure.message).toContain(`directory ${claimed} (daemon unknown)`);
        expect(yield* fs.exists(claimed)).toBe(true);
        expect((yield* state.readClaims(saved.id)).map((claim) => claim.id)).toEqual([claimed]);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("drops a claimed directory that no longer exists, for a native stack with no engine", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-directory-sweep-gone-" });
      const state = yield* stateFor(`${root}/state`);
      const saved = {
        id: "stack",
        runtime: "native" as const,
        identity: { projectRoot: root, branchContext: "main", stackName: "directory-sweep-gone" },
        instances: [],
        lifetime: "detached" as const,
        composition: { members: [], dependencies: [] },
        ports: [],
      };
      yield* state.save(saved);
      // Never created on disk: the owner that journaled it crashed before the directory existed.
      const gone = path.join(root, "pg-never-existed");
      yield* state.claim(saved.id, { kind: "directory", id: gone });
      const ownerLayer = Owner.layer({
        saved,
        root: `${root}/data`,
        cacheRoot: `${root}/cache`,
      }).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(StackNamespace.Service, state),
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() => Effect.die("Unexpected child process command")),
            ),
          ),
        ),
      );
      const owner = yield* Layer.build(ownerLayer).pipe(
        Effect.map((context) => Context.get(context, Owner.Service)),
      );
      yield* owner.namespace.destroy;
      expect(yield* state.readClaims(saved.id)).toEqual([]);
      expect(yield* state.read(saved.id)).toBeUndefined();
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live(
  "keeps a container claim recorded against a different daemon, never removing or dropping it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "stack-container-sweep-daemon-",
        });
        const state = yield* stateFor(`${root}/state`);
        const saved = {
          id: "stack",
          runtime: "docker" as const,
          identity: { projectRoot: root, branchContext: "main", stackName: "sweep-daemon" },
          instances: [],
          lifetime: "detached" as const,
          composition: { members: [], dependencies: [] },
          ports: [],
        };
        yield* state.save(saved);
        // Recorded against a daemon this reconcile run will never match.
        yield* state.claim(saved.id, {
          kind: "container",
          id: containerId,
          daemonId: "other-daemon",
        });
        let rmCalls = 0;
        const engine = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command) || command.command !== "docker")
            return Effect.die("Unexpected child process command");
          if (command.args[0] === "rm" && command.args.includes(containerId)) rmCalls++;
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(0),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            }),
          );
        });
        const ownerLayer = Owner.layer({
          saved,
          root: `${root}/data`,
          cacheRoot: `${root}/cache`,
          engineTarget,
        }).pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(StackNamespace.Service, state),
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, engine),
            ),
          ),
        );
        const owner = yield* Layer.build(ownerLayer).pipe(
          Effect.map((context) => Context.get(context, Owner.Service)),
        );
        const failure = yield* owner.namespace.destroy.pipe(Effect.flip);
        expect(rmCalls).toBe(0);
        expect(failure.message).toContain(`container ${containerId} (daemon other-daemon)`);
        expect(failure.message).toContain("Current daemon: current-daemon.");
        expect(failure.message).toContain(`${root}/state/stack/claims.json`);
        // Kept, not dropped: a full deregistration would otherwise have discarded it unreconciled.
        expect(yield* state.read(saved.id)).toBeDefined();
        expect((yield* state.readClaims(saved.id)).map((claim) => claim.id)).toEqual([containerId]);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live(
  "keeps a container claim with no recorded daemon id, even once the current daemon is known",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "stack-container-sweep-no-daemon-",
        });
        const state = yield* stateFor(`${root}/state`);
        const saved = {
          id: "stack",
          runtime: "docker" as const,
          identity: { projectRoot: root, branchContext: "main", stackName: "sweep-no-daemon" },
          instances: [],
          lifetime: "detached" as const,
          composition: { members: [], dependencies: [] },
          ports: [],
        };
        yield* state.save(saved);
        // No daemon id recorded at all, unlike a mismatched one: nothing to compare the current,
        // successfully-resolved daemon against, so this is kept too, not removed by assuming it's
        // the same daemon.
        yield* state.claim(saved.id, { kind: "container", id: containerId });
        let rmCalls = 0;
        const engine = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command) || command.command !== "docker")
            return Effect.die("Unexpected child process command");
          if (command.args[0] === "rm" && command.args.includes(containerId)) rmCalls++;
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(0),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              unref: Effect.succeed(Effect.void),
            }),
          );
        });
        const ownerLayer = Owner.layer({
          saved,
          root: `${root}/data`,
          cacheRoot: `${root}/cache`,
          engineTarget,
        }).pipe(
          Layer.provide(
            Layer.merge(
              Layer.succeed(StackNamespace.Service, state),
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, engine),
            ),
          ),
        );
        const owner = yield* Layer.build(ownerLayer).pipe(
          Effect.map((context) => Context.get(context, Owner.Service)),
        );
        const failure = yield* owner.namespace.destroy.pipe(Effect.flip);
        expect(rmCalls).toBe(0);
        expect(failure.message).toContain(`container ${containerId} (daemon unknown)`);
        expect(failure.message).toContain("Current daemon: current-daemon.");
        expect(yield* state.read(saved.id)).toBeDefined();
        expect((yield* state.readClaims(saved.id)).map((claim) => claim.id)).toEqual([containerId]);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);
