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
  Option,
  Path,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { launchHost } from "./HostProcess.ts";
import { makeContainerRuntime } from "./runtime/Container.ts";
import * as State from "./State.ts";
import { makeDockerDatabaseRoot } from "../tests/docker-fixture.ts";
import { shutdownOwner, watchLeaseRelease } from "../tests/owner.ts";

class SweepTestError extends Data.TaggedError("SweepTestError")<{ readonly message: string }> {}

const helperImage =
  "public.ecr.aws/docker/library/debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251";

const docker = Effect.fn("SweepTest.docker")((args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("docker", args, { stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
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
        return yield* Effect.die(`docker ${args.join(" ")} failed: ${stderr}`);
      return stdout.trim();
    }),
  ),
);

const labels = (stackId: string, dataRoot: string) => [
  `label=com.supabase.stack=${stackId}`,
  `label=com.supabase.stack-root=${dataRoot}`,
];

const containers = (stackId: string, dataRoot: string) =>
  docker([
    "ps",
    "--all",
    "--quiet",
    "--no-trunc",
    ...labels(stackId, dataRoot).flatMap((label) => ["--filter", label]),
  ]).pipe(Effect.map((value) => value.split("\n").filter((id) => id.length > 0)));

const createOwnedContainer = (stackId: string, dataRoot: string) =>
  Effect.acquireRelease(
    docker([
      "create",
      ...labels(stackId, dataRoot).flatMap((label) => ["--label", label.slice("label=".length)]),
      helperImage,
    ]),
    (id) => docker(["rm", "--force", id]).pipe(Effect.ignore),
  );

/** Completes when Docker reports the container destroyed, including events before subscription. */
const awaitDestroyed = (id: string, since: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const events = yield* spawner.spawn(
        ChildProcess.make(
          "docker",
          [
            "events",
            "--since",
            String(since),
            "--filter",
            `container=${id}`,
            "--filter",
            "event=destroy",
            "--format",
            "{{.Actor.ID}}",
          ],
          { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
        ),
      );
      const destroyed = yield* events.stdout.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter((line) => line.trim() === id),
        Stream.runHead,
      );
      if (Option.isNone(destroyed))
        return yield* new SweepTestError({ message: "Docker event stream ended" });
    }),
  );

const awaitRemoval = (directory: string, entry: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(directory, entry);
    yield* fs.watch(directory).pipe(
      Stream.filter((event) => event.path === entry || event.path === target),
      Stream.mapEffect(() => fs.exists(target)),
      Stream.takeUntil((exists) => !exists),
      Stream.runDrain,
    );
  });

const saved = (
  id: string,
  projectRoot: string,
  runtime: State.SavedStack["runtime"],
  lifetime: State.StackLifetime,
): State.SavedStack => ({
  id,
  runtime,
  lifetime,
  identity: { projectRoot, branchContext: "sweep-test", stackName: id },
  instances: [],
  composition: { members: [], dependencies: [] },
  ports: [],
});

it.live.skipIf(process.platform === "win32")(
  "removes a dead owner's containers and session stacks at the next owner start in its root",
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
        const helper = yield* makeContainerRuntime({ engine: "docker", root: dataA });
        yield* helper.prepare(helperImage);
        const state = Context.get(yield* Layer.build(State.layer({ root: rootA })), State.Service);

        yield* state.save(saved(deadId, `${rootA}/dead`, "docker", "detached"));
        const dead = (yield* launchHost(state, { stateRoot: rootA, cacheRoot, stackId: deadId }))
          .endpoint;
        const orphan = yield* createOwnedContainer(deadId, dataA);
        const otherRoot = yield* createOwnedContainer(deadId, dataB);
        const deadReleased = yield* watchLeaseRelease(rootA, deadId);
        yield* Effect.sync(() => process.kill(dead.pid, "SIGKILL"));
        yield* deadReleased;
        expect(yield* containers(deadId, dataA)).toEqual([orphan]);

        const sessionId = `session-${suffix}`;
        yield* state.save(saved(sessionId, `${rootA}/session`, "native", "session"));
        const nextId = `next-${suffix}`;
        yield* state.save(saved(nextId, `${rootA}/next`, "native", "detached"));

        const since = Math.floor((yield* Clock.currentTimeMillis) / 1000) - 1;
        const swept = yield* Effect.all(
          [
            awaitDestroyed(orphan, since),
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
        expect(yield* state.read(deadId), "detached stacks keep their state").toBeDefined();
        expect(yield* state.read(sessionId)).toBeUndefined();
        expect(yield* state.leased(deadId), "the sweeper released the dead stack").toBe(false);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
  { timeout: 180_000 },
);
