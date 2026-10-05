import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as StackNamespace from "./StackNamespace.ts";
import * as Owner from "./Owner.ts";
import { NativeRuntimeRootBase, nativeRuntimeRootPath } from "./runtime/postgres-user.ts";

const stateFor = (root: string) =>
  Layer.build(StackNamespace.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, StackNamespace.Service)),
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
        expect(failure.message).toContain(`directory ${foreign}`);
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
        expect(failure.message).toContain(`directory ${claimed}`);
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
