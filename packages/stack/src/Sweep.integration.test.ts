import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Clock,
  Context,
  Crypto,
  Data,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Queue,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- test-only native watcher for synchronous attachment, no Effect wrapper gives this guarantee.
import { watch as nodeWatch } from "node:fs";
import { launchHost } from "./HostProcess.ts";
import { makeContainerRuntime, type EngineTarget } from "./runtime/Container.ts";
import * as StackNamespace from "./StackNamespace.ts";
import { reclaimDeletedStack, reclaimStack, sweepOrphans } from "./Sweep.ts";
import { engineStub, makeDockerDatabaseRoot } from "../tests/docker-fixture.ts";
import { awaitContainerRemoved } from "../tests/engine-events.ts";
import { engineTarget, testEngine } from "../tests/engine-target.ts";
import { shutdownOwner, watchLeaseRelease } from "../tests/owner.ts";

class SweepTestError extends Data.TaggedError("SweepTestError")<{ readonly message: string }> {}

const helperImage =
  "public.ecr.aws/docker/library/debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251";

const engine = Effect.fn("SweepTest.engine")((args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(testEngine, [...engineTarget.argv, ...args], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(code) !== 0)
        return yield* Effect.die(`${testEngine} ${args.join(" ")} failed: ${stderr}`);
      return stdout.trim();
    }),
  ),
);

const labels = (stackId: string, dataRoot: string) => [
  `label=com.supabase.stack=${stackId}`,
  `label=com.supabase.stack-root=${dataRoot}`,
];

const containers = (stackId: string, dataRoot: string) =>
  engine([
    "ps",
    "--all",
    "--quiet",
    "--no-trunc",
    ...labels(stackId, dataRoot).flatMap((label) => ["--filter", label]),
  ]).pipe(Effect.map((value) => value.split("\n").filter((id) => id.length > 0)));

const createOwnedContainer = (stackId: string, dataRoot: string) =>
  Effect.acquireRelease(
    engine([
      "create",
      ...labels(stackId, dataRoot).flatMap((label) => ["--label", label.slice("label=".length)]),
      helperImage,
    ]),
    (id) => engine(["rm", "--force", id]).pipe(Effect.ignore),
  );

/**
 * Watches `directory` and waits for `entry`'s removal, scoped to the caller's own fork so the
 * watcher closes as soon as it returns. `node:fs.watch` itself is synchronous, so acquiring it
 * directly (rather than through `Stream`, which forks registration through `Stream.callback`,
 * `Channel.callbackArray`, and `asyncQueue` before it actually attaches) guarantees the watcher is
 * live before this returns: no canary handshake needed. Node reports non-recursive watch events by
 * bare filename and sometimes coalesces them, so any event re-checks the real directory instead of
 * trusting which path it names. The watcher's native resource is torn down whether or not removal
 * ever arrives, so this never succeeds by a wait simply running out.
 */
const awaitRemoval = Effect.fn("SweepTest.awaitRemoval")(function* (
  directory: string,
  entry: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = path.join(directory, entry);
  const queue = yield* Queue.unbounded<string>();
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      nodeWatch(directory, (_event, filename) => {
        if (filename) Queue.offerUnsafe(queue, filename);
      }),
    ),
    (watcher) => Effect.sync(() => watcher.close()),
  );

  while (yield* fs.exists(target)) yield* Queue.take(queue);
});

const saved = (
  id: string,
  projectRoot: string,
  runtime: StackNamespace.SavedStack["runtime"],
  lifetime: StackNamespace.StackLifetime,
): StackNamespace.SavedStack => ({
  id,
  runtime,
  lifetime,
  identity: { projectRoot, branchContext: "sweep-test", stackName: id },
  instances: [],
  composition: { members: [], dependencies: [] },
});

it.live.skipIf(process.platform === "win32")(
  "removes dead owners' and deleted stacks' containers and session stacks at the next owner start in its root",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const suffix = (yield* crypto.randomUUIDv4).replaceAll("-", "");
        const deadId = `dead-${suffix}`;
        const dataA = yield* makeDockerDatabaseRoot("stack-sweep-a-", deadId).pipe(
          Effect.flatMap(fs.realPath),
        );
        const dataB = yield* makeDockerDatabaseRoot("stack-sweep-b-", deadId).pipe(
          Effect.flatMap(fs.realPath),
        );
        const rootA = path.dirname(path.dirname(dataA));
        const cacheRoot = `${path.dirname(rootA)}/cache`;
        const helper = yield* makeContainerRuntime({
          target: engineTarget,
          root: dataA,
        });
        yield* helper.prepare(helperImage);
        const state = Context.get(
          yield* Layer.build(StackNamespace.layer({ root: rootA })),
          StackNamespace.Service,
        );

        yield* state.save(saved(deadId, `${rootA}/dead`, testEngine, "detached"));
        const dead = (yield* launchHost(state, { stateRoot: rootA, cacheRoot, stackId: deadId }))
          .endpoint;
        const orphan = yield* createOwnedContainer(deadId, dataA);
        const otherRoot = yield* createOwnedContainer(deadId, dataB);
        const deadReleased = yield* watchLeaseRelease(rootA, deadId);
        yield* Effect.sync(() => process.kill(dead.pid, "SIGKILL"));
        yield* deadReleased;
        expect(yield* containers(deadId, dataA)).toEqual([orphan]);
        // Created after the dead owner exits, so only the next owner's sweep can remove them.
        const deletedId = `${suffix}${suffix}`;
        const deletedData = path.join(rootA, deletedId, "data");
        const deletedOtherData = path.join(path.dirname(path.dirname(dataB)), deletedId, "data");
        const deleted = yield* createOwnedContainer(deletedId, deletedData);
        const deletedOtherRoot = yield* createOwnedContainer(deletedId, deletedOtherData);

        const sessionId = `session-${suffix}`;
        yield* state.save(saved(sessionId, `${rootA}/session`, "native", "session"));
        const nextId = `next-${suffix}`;
        yield* state.save(saved(nextId, `${rootA}/next`, testEngine, "detached"));

        const since = Math.floor((yield* Clock.currentTimeMillis) / 1000) - 1;
        const swept = yield* Effect.all(
          [
            awaitContainerRemoved(orphan, since),
            awaitContainerRemoved(deleted, since),
            awaitRemoval(rootA, sessionId),
            awaitRemoval(path.join(rootA, deadId), "owner.json"),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild({ startImmediately: true }));
        const next = yield* Effect.acquireRelease(
          launchHost(state, { stateRoot: rootA, cacheRoot, stackId: nextId }),
          (access) => shutdownOwner(access, true).pipe(Effect.ignore),
        );
        yield* Fiber.join(swept).pipe(
          Effect.timeoutOrElse({
            duration: "1 minute",
            orElse: () =>
              Effect.fail(new SweepTestError({ message: "The next owner did not sweep orphans" })),
          }),
        );

        // The sweeper retracts its marker, then releases the lease.
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* yield* watchLeaseRelease(rootA, deadId);
          }),
        );
        expect(next.endpoint.pid).not.toBe(dead.pid);
        expect(yield* containers(deadId, dataA)).toEqual([]);
        expect(yield* containers(deadId, dataB), "another root is never swept").toEqual([
          otherRoot,
        ]);
        expect(yield* containers(deletedId, deletedData)).toEqual([]);
        expect(
          yield* containers(deletedId, deletedOtherData),
          "another root's deleted stack is never swept",
        ).toEqual([deletedOtherRoot]);
        expect(yield* state.read(deadId), "detached stacks keep their state").toBeDefined();
        expect(yield* state.read(sessionId)).toBeUndefined();
        expect(yield* state.leased(deadId), "the sweeper released the dead stack").toBe(false);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);

it.live(
  "an orphan sweep removes destroyed stack directories once they are older than the restart window",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-sweep-prune-" });
        const state = Context.get(
          yield* Layer.build(StackNamespace.layer({ root })),
          StackNamespace.Service,
        );
        const elevenMinutesAgo = Math.floor((yield* Clock.currentTimeMillis) / 1000) - 11 * 60;
        const arrange = Effect.fn("SweepTest.arrange")(function* (
          id: string,
          options: { readonly old: boolean; readonly file?: string; readonly dataFile?: string },
        ) {
          const directory = path.join(root, id);
          yield* fs.makeDirectory(path.join(directory, "data"), { recursive: true });
          if (options.file !== undefined)
            yield* fs.writeFileString(path.join(directory, options.file), "x");
          if (options.dataFile !== undefined)
            yield* fs.writeFileString(path.join(directory, "data", options.dataFile), "x");
          if (options.old) yield* fs.utimes(directory, elevenMinutesAgo, elevenMinutesAgo);
        });
        yield* arrange("old-empty", { old: true });
        yield* arrange("fresh-empty", { old: false });
        yield* arrange("old-with-data", { old: true, dataFile: "PG_VERSION" });
        yield* arrange("old-with-lock", { old: true, file: "owner.lock" });
        yield* arrange("old-kept", { old: true });

        yield* sweepOrphans({
          state,
          stateRoot: root,
          cacheRoot: path.join(root, "cache"),
          ownerId: "old-kept",
        });

        expect(yield* fs.exists(path.join(root, "old-empty"))).toBe(false);
        expect(yield* fs.exists(path.join(root, "fresh-empty", "data"))).toBe(true);
        expect(yield* fs.exists(path.join(root, "old-with-data", "data", "PG_VERSION"))).toBe(true);
        expect(yield* fs.exists(path.join(root, "old-with-lock", "owner.lock"))).toBe(true);
        expect(yield* fs.exists(path.join(root, "old-kept", "data"))).toBe(true);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("reclaiming a session stack refuses a symlinked data directory and keeps its target", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-sweep-symlinked-data-" });
      const stateRoot = path.join(root, "state");
      const state = Context.get(
        yield* Layer.build(StackNamespace.layer({ root: stateRoot })),
        StackNamespace.Service,
      );
      const stack = saved("symlinked-data", root, "native", "session");
      yield* state.save(stack);
      const outside = path.join(root, "outside");
      yield* fs.makeDirectory(outside);
      yield* fs.writeFileString(path.join(outside, "precious.txt"), "keep");
      yield* fs.symlink(outside, path.join(stateRoot, stack.id, "data"));

      const failure = yield* reclaimStack({
        state,
        stateRoot,
        cacheRoot: path.join(root, "cache"),
        id: stack.id,
      }).pipe(Effect.flip);

      expect(failure.message).toContain("symlink");
      expect(yield* fs.readFileString(path.join(outside, "precious.txt"))).toBe("keep");
      expect(yield* state.read(stack.id), "the registration stays for a retry").toBeDefined();
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("sweeps deleted stacks of its own root only, on the engine its owner pinned", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateRoot = yield* fs
        .makeTempDirectoryScoped({ prefix: "stack-sweep-deleted-" })
        .pipe(Effect.flatMap(fs.realPath));
      const real = Context.get(
        yield* Layer.build(StackNamespace.layer({ root: stateRoot })),
        StackNamespace.Service,
      );
      const swept: Array<string> = [];
      const state: StackNamespace.Interface = {
        ...real,
        acquireLease: (id) =>
          Effect.suspend(() => {
            swept.push(id);
            return real.acquireLease(id);
          }),
      };
      const deletedId = "d".repeat(64);
      const heldId = "a".repeat(64);
      const foreignId = "f".repeat(64);
      const deletedData = path.join(stateRoot, deletedId, "data");
      const engine = engineStub([
        { id: "owner", stackId: "owner", root: path.join(stateRoot, "owner", "data") },
        { id: "deleted", stackId: deletedId, root: deletedData },
        { id: "deleted-sibling", stackId: deletedId, root: deletedData },
        { id: "held", stackId: heldId, root: path.join(stateRoot, heldId, "data") },
        {
          id: "foreign",
          stackId: foreignId,
          root: path.join(path.dirname(stateRoot), "other", foreignId, "data"),
        },
        { id: "escape", stackId: "../escape", root: path.join(stateRoot, "..", "escape", "data") },
        "malformed",
      ]);
      const pinned: EngineTarget = {
        engine: "docker",
        argv: ["--context", "pinned"],
        daemonId: "pinned-daemon",
      };
      const cacheRoot = path.join(stateRoot, "cache");
      yield* Context.get(
        yield* Layer.build(StackNamespace.layer({ root: stateRoot })),
        StackNamespace.Service,
      ).acquireLease(heldId);

      yield* sweepOrphans({
        state,
        stateRoot,
        cacheRoot,
        ownerId: "owner",
        engineTarget: pinned,
      }).pipe(Effect.provide(engine.layer));

      expect(swept, "only deleted stacks of this root are attempted").toEqual([deletedId, heldId]);
      expect(
        engine.remaining("docker").map(({ id }) => id),
        "the held stack's containers stay",
      ).toEqual(["owner", "held", "foreign", "escape"]);
      expect(engine.commands).toContainEqual([
        "docker",
        ...pinned.argv,
        "ps",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        `label=com.supabase.stack=${deletedId}`,
        "--filter",
        `label=com.supabase.stack-root=${deletedData}`,
      ]);
      expect(
        engine.commands.filter(([command]) => command === "podman"),
        "only the owner's engine is queried",
      ).toEqual([]);
      expect(
        yield* fs.exists(path.join(stateRoot, deletedId)),
        "the sweeper's lease leaves no directory behind",
      ).toBe(false);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);

it.live("does not reclaim a stack that is registered as a deleted one", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateRoot = yield* fs
        .makeTempDirectoryScoped({ prefix: "stack-reclaim-registered-" })
        .pipe(Effect.flatMap(fs.realPath));
      const state = Context.get(
        yield* Layer.build(StackNamespace.layer({ root: stateRoot })),
        StackNamespace.Service,
      );
      const id = "b".repeat(64);
      const engine = engineStub([
        { id: "live", stackId: id, root: path.join(stateRoot, id, "data") },
      ]);
      yield* state.save(saved(id, path.join(stateRoot, "project"), "docker", "detached"));

      const outcome = yield* reclaimDeletedStack({
        state,
        stateRoot,
        id,
        engineTarget: { engine: "docker", argv: [], daemonId: "stub" },
      }).pipe(Effect.provide(engine.layer));

      expect(outcome).toBe("registered");
      expect(engine.remaining("docker").map(({ id: removed }) => removed)).toEqual(["live"]);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);
