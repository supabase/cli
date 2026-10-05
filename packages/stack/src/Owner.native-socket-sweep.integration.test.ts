import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { createHash } from "node:crypto";
import {
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  PlatformError,
  Redacted,
  Ref,
  Schema,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Owner from "./Owner.ts";
import { NativeRuntimeRootBase, nativeRuntimeRootPath } from "./runtime/postgres-user.ts";
import { ServiceCreation } from "./services/Catalog.ts";
import * as StackNamespace from "./StackNamespace.ts";
import { reclaimStack } from "./Sweep.ts";

const databaseCreation = Schema.decodeEffect(ServiceCreation)({
  service: "database",
  config: {
    version: "17",
    databasePassword: Redacted.make("sweep-password"),
    jwtSecret: Redacted.make("sweep-integration-jwt-secret-long-enough"),
    jwtExpiry: 3600,
  },
  endpoints: {},
});

/** A fresh state namespace, a native runtime root base, and a stack with one saved database. */
const arrange = Effect.fn("arrange")(function* (
  id: string,
  lifetime: StackNamespace.SavedStack["lifetime"] = "detached",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs
    .makeTempDirectoryScoped({ prefix: "stack-socket-sweep-" })
    .pipe(Effect.flatMap(fs.realPath));
  const state = Context.get(
    yield* Layer.build(StackNamespace.layer({ root: `${root}/state` })),
    StackNamespace.Service,
  );
  const saved: StackNamespace.SavedStack = {
    id,
    runtime: "native",
    identity: { projectRoot: root, branchContext: "main", stackName: id },
    instances: [{ id: "database", creation: yield* databaseCreation }],
    lifetime,
    composition: { members: [], dependencies: [] },
  };
  yield* state.save(saved);
  const runtimeRootBase = yield* fs.makeTempDirectoryScoped({ prefix: "stack-socket-sweep-base-" });
  const runtimeRoot = nativeRuntimeRootPath(path, runtimeRootBase, process.getuid?.() ?? 0);
  const dataRoot = `${root}/state/${id}/data`;
  return { root, state, saved, runtimeRootBase, runtimeRoot, dataRoot };
});

type Arrangement = Effect.Success<ReturnType<typeof arrange>>;

/** The socket directory a native database instance gets, derived independently of production code. */
const socketDirectory = (arrangement: Arrangement, instanceId: string) =>
  `${arrangement.runtimeRoot}/pg-${createHash("sha256")
    .update(`${arrangement.dataRoot}\0${instanceId}`)
    .digest("hex")
    .slice(0, 16)}`;

/** A directory left by an owner that was SIGKILLed before its scope could remove it. */
const leaveSocketDirectory = Effect.fn("leaveSocketDirectory")(function* (
  arrangement: Arrangement,
  instanceId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = socketDirectory(arrangement, instanceId);
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.writeFileString(`${directory}/pg_hba.conf`, "local all all trust\n");
  return directory;
});

const ownerFor = (arrangement: Arrangement, fileSystem?: Layer.Layer<FileSystem.FileSystem>) => {
  const owner = Owner.layer({
    saved: arrangement.saved,
    root: arrangement.dataRoot,
    cacheRoot: `${arrangement.root}/cache`,
  }).pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(StackNamespace.Service, arrangement.state),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Unexpected child process command")),
        ),
      ),
    ),
  );
  return Layer.build(fileSystem === undefined ? owner : owner.pipe(Layer.provide(fileSystem))).pipe(
    Effect.map((context) => Context.get(context, Owner.Service)),
  );
};

/** Destroy runs in the caller's context, which names the runtime root base launch would use. */
const inRuntimeRoot = (arrangement: Arrangement) =>
  Effect.provideService(NativeRuntimeRootBase, arrangement.runtimeRootBase);

const platform = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);

it.live("destroy removes the socket directory a killed owner left behind", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const arrangement = yield* arrange("socket-destroy");
      const leftover = yield* leaveSocketDirectory(arrangement, "database");
      const owner = yield* ownerFor(arrangement);

      yield* owner.namespace.destroy.pipe(inRuntimeRoot(arrangement));

      expect(yield* fs.exists(leftover)).toBe(false);
    }),
  ).pipe(Effect.provide(platform)),
);

it.live("a failed socket directory removal keeps the stack registered until a retry succeeds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const arrangement = yield* arrange("socket-retry");
      const leftover = yield* leaveSocketDirectory(arrangement, "database");
      const failing = yield* Ref.make(true);
      const flakyFs = Layer.succeed(FileSystem.FileSystem, {
        ...fs,
        remove: (target: string, options?: Parameters<FileSystem.FileSystem["remove"]>[1]) =>
          // The runtime root is resolved to its real path, so match the derived directory name.
          target.endsWith(`/${leftover.split("/").at(-1)}`)
            ? Ref.get(failing).pipe(
                Effect.flatMap((fail) =>
                  fail
                    ? PlatformError.systemError({
                        _tag: "Unknown",
                        module: "FileSystem",
                        method: "remove",
                        pathOrDescriptor: target,
                        cause: new Error("injected removal failure"),
                      })
                    : fs.remove(target, options),
                ),
              )
            : fs.remove(target, options),
      });
      const owner = yield* ownerFor(arrangement, flakyFs);

      const failed = yield* Effect.exit(owner.namespace.destroy.pipe(inRuntimeRoot(arrangement)));

      expect(Exit.isFailure(failed)).toBe(true);
      expect(yield* fs.exists(leftover)).toBe(true);
      expect(yield* arrangement.state.read(arrangement.saved.id)).toBeDefined();

      yield* Ref.set(failing, false);
      yield* owner.namespace.destroy.pipe(inRuntimeRoot(arrangement));

      expect(yield* fs.exists(leftover)).toBe(false);
      expect(yield* arrangement.state.read(arrangement.saved.id)).toBeUndefined();
    }),
  ).pipe(Effect.provide(platform)),
);

it.live("destroying one database instance removes its socket directory", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const arrangement = yield* arrange("socket-instance");
      const leftover = yield* leaveSocketDirectory(arrangement, "database");
      const owner = yield* ownerFor(arrangement);

      yield* owner.handlers.destroyService({ id: "database" }).pipe(inRuntimeRoot(arrangement));

      expect(yield* fs.exists(leftover)).toBe(false);
    }),
  ).pipe(Effect.provide(platform)),
);

const reclaim = (arrangement: Arrangement) =>
  reclaimStack({
    state: arrangement.state,
    stateRoot: `${arrangement.root}/state`,
    cacheRoot: `${arrangement.root}/cache`,
    id: arrangement.saved.id,
  }).pipe(Effect.provide(Layer.succeed(NativeRuntimeRootBase, arrangement.runtimeRootBase)));

it.live(
  "an orphan reclaim removes the socket directory of a session stack whose owner is gone",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const arrangement = yield* arrange("socket-orphan", "session");
        const leftover = yield* leaveSocketDirectory(arrangement, "database");

        expect(yield* reclaim(arrangement)).toBe(true);

        expect(yield* fs.exists(leftover)).toBe(false);
      }),
    ).pipe(Effect.provide(platform)),
);

it.live(
  "an orphan reclaim finds the socket directory of a stack whose data root is a symlink",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const arrangement = yield* arrange("socket-symlink", "session");
        const relocated = `${arrangement.root}/relocated-data`;
        yield* fs.makeDirectory(relocated);
        yield* fs.symlink(relocated, arrangement.dataRoot);
        // Launch hashes the data root's real path, so a leftover is named from it.
        const leftover = yield* leaveSocketDirectory(
          { ...arrangement, dataRoot: relocated },
          "database",
        );

        expect(yield* reclaim(arrangement)).toBe(true);

        expect(yield* fs.exists(leftover)).toBe(false);
      }),
    ).pipe(Effect.provide(platform)),
);

it.live("removes only the socket directory of the stack being cleaned up", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cleaned = yield* arrange("socket-cleaned");
      const sibling = yield* arrange("socket-sibling");
      const cleanedLeftover = yield* leaveSocketDirectory(cleaned, "database");
      // Same instance id and runtime root, different stack: a distinct derived name.
      const siblingLeftover = yield* leaveSocketDirectory(
        { ...sibling, runtimeRoot: cleaned.runtimeRoot },
        "database",
      );
      const owner = yield* ownerFor(cleaned);

      yield* owner.namespace.destroy.pipe(inRuntimeRoot(cleaned));

      expect(yield* fs.exists(cleanedLeftover)).toBe(false);
      expect(yield* fs.exists(siblingLeftover)).toBe(true);
    }),
  ).pipe(Effect.provide(platform)),
);

it.live("leaves a socket directory under a runtime root another uid could have taken over", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const arrangement = yield* arrange("socket-takeover");
      const leftover = yield* leaveSocketDirectory(arrangement, "database");
      // Tests cannot create another uid's files, so a world-writable root stands in for one
      // recreated by a foreign uid.
      yield* fs.chmod(arrangement.runtimeRoot, 0o777);
      const owner = yield* ownerFor(arrangement);

      yield* owner.namespace.destroy.pipe(inRuntimeRoot(arrangement));

      expect(yield* fs.exists(leftover)).toBe(true);
    }),
  ).pipe(Effect.provide(platform)),
);
