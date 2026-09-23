import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Clock, Context, Crypto, Data, Effect, FileSystem, Layer, Queue, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as State from "./State.ts";
import { launchHost, waitForOwnerExit } from "./HostProcess.ts";
import { StackRpc } from "./Rpc.ts";

class HostSignalError extends Data.TaggedError("HostSignalError")<{
  readonly message: string;
  readonly code?: string;
}> {}

const runDocker = Effect.fn("ContainerSentinelHostTest.runDocker")((args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make("docker", args, { stdout: "pipe", stderr: "pipe" }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { stdout: stdout.trim(), stderr: stderr.trim(), code: Number(code) };
    }),
  ),
);

const requireDocker = (args: ReadonlyArray<string>) =>
  runDocker(args).pipe(
    Effect.flatMap((result) =>
      result.code === 0
        ? Effect.succeed(result.stdout)
        : Effect.die(`docker ${args.join(" ")} failed: ${result.stderr}`),
    ),
  );

const makeState = (root: string) =>
  Layer.build(State.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, State.Service)),
  );

const removeStackContainers = Effect.fn("ContainerSentinelHostTest.removeStackContainers")(
  (stackId: string) =>
    requireDocker([
      "ps",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `label=com.supabase.stack=${stackId}`,
    ]).pipe(
      Effect.flatMap((ids) =>
        Effect.forEach(
          ids.split("\n").filter((id) => id.length > 0),
          (id) =>
            runDocker(["rm", "--force", id]).pipe(
              Effect.flatMap((result) =>
                result.code === 0 || /no such container/iu.test(result.stderr)
                  ? Effect.void
                  : Effect.die(`docker rm ${id} failed: ${result.stderr}`),
              ),
            ),
          { concurrency: 1, discard: true },
        ),
      ),
    ),
);

const clientFor = (port: number) =>
  RpcClient.make(StackRpc).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({ url: `http://127.0.0.1:${port}/rpc` }).pipe(
        Layer.provide(RpcSerialization.layerNdjson),
      ),
    ),
  );

const startEvents = (stackId: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const now = yield* Clock.currentTimeMillis;
    const since = String(Math.floor((now - 60_000) / 1000));
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "docker",
        [
          "events",
          "--since",
          since,
          "--filter",
          "type=container",
          "--filter",
          `label=com.supabase.stack=${stackId}`,
          "--format",
          "{{.Action}} {{.Actor.ID}}",
        ],
        { stdout: "pipe", stderr: "ignore" },
      ),
    );
    const events = yield* Queue.unbounded<string>();
    yield* child.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => Queue.offer(events, line)),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() => child.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore));
    return events;
  });

const awaitEvent = (events: Queue.Queue<string>, action: string, containerId: string) =>
  Effect.gen(function* () {
    while (true) {
      const line = yield* Queue.take(events);
      const [seenAction, seenId] = line.trim().split(/\s+/u);
      if (seenAction === action && seenId !== undefined && containerId.startsWith(seenId)) return;
    }
  }).pipe(Effect.timeout("30 seconds"));

const endpointFor = (
  state: State.Interface,
  stateRoot: string,
  cacheRoot: string,
  stackId: string,
  projectRoot: string,
) =>
  Effect.gen(function* () {
    yield* state.save({
      id: stackId,
      runtime: "docker",
      identity: { projectRoot, branchContext: "host-kill-test", stackName: stackId },
      instances: [],
      composition: { members: [], dependencies: [] },
      ports: [],
    });
    const endpoint = yield* launchHost(state, { stateRoot, cacheRoot, stackId });
    const host = { endpoint, stackId, stopped: false };
    const signal = (killSignal: NodeJS.Signals) =>
      Effect.try({
        try: () => process.kill(endpoint.pid, killSignal),
        catch: (cause) => {
          const code =
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            typeof cause.code === "string"
              ? cause.code
              : undefined;
          return new HostSignalError({
            message: String(cause),
            ...(code === undefined ? {} : { code }),
          });
        },
      }).pipe(Effect.catch((cause) => (cause.code === "ESRCH" ? Effect.void : Effect.fail(cause))));
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (!host.stopped) yield* signal("SIGTERM").pipe(Effect.catch(() => Effect.void));
        yield* waitForOwnerExit(endpoint.pid).pipe(
          Effect.timeout("10 seconds"),
          Effect.catch(() =>
            signal("SIGKILL").pipe(Effect.andThen(waitForOwnerExit(endpoint.pid))),
          ),
          Effect.andThen(removeStackContainers(stackId)),
        );
      }).pipe(Effect.orDie),
    );
    return host;
  });

const inspectRunning = (containerId: string) =>
  requireDocker(["inspect", "--format", "{{.State.Running}}", containerId]);

const assertAbsent = (containerId: string) =>
  runDocker(["ps", "--all", "--quiet", "--no-trunc", "--filter", `id=${containerId}`]).pipe(
    Effect.flatMap((result) => {
      if (result.code !== 0) return Effect.die(`docker ps failed: ${result.stderr}`);
      expect(result.stdout).toBe("");
      return Effect.void;
    }),
  );

const createMail = (client: ReturnType<typeof clientFor>) =>
  client.pipe(
    Effect.flatMap((service) =>
      service.createService({
        service: "mail",
        config: {},
        endpoints: {
          http: { port: "auto" },
          smtp: { port: "auto" },
          pop3: { port: "auto" },
        },
      }),
    ),
  );

const startMail = (client: Parameters<typeof createMail>[0], id: string) =>
  client.pipe(
    Effect.flatMap((service) => service.startService({ id })),
    Effect.andThen(client.pipe(Effect.flatMap((service) => service.readyService({ id })))),
  );

it.live.skipIf(process.platform === "win32")(
  "reaps only the killed StackHost generation while its parallel stack remains owned",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const crypto = yield* Crypto.Crypto;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "container-sentinel-host-" });
        const stateRoot = `${root}/state`;
        const cacheRoot = `${root}/cache`;
        const state = yield* makeState(stateRoot);
        const unique = (yield* crypto.randomUUIDv4).replaceAll("-", "");
        const killedStackId = `killed-${unique}`;
        const parallelStackId = `parallel-${unique}`;
        const hosts = yield* Effect.all(
          [
            endpointFor(state, stateRoot, cacheRoot, killedStackId, root),
            endpointFor(state, stateRoot, cacheRoot, parallelStackId, root),
          ],
          { concurrency: 1 },
        );
        const killedHost = hosts[0];
        const parallelHost = hosts[1];
        if (killedHost === undefined || parallelHost === undefined)
          return yield* Effect.die("Both stack hosts must start");

        const killedClient = yield* clientFor(killedHost.endpoint.port);
        const parallelClient = yield* clientFor(parallelHost.endpoint.port);
        const killedMail = yield* createMail(Effect.succeed(killedClient));
        const parallelMail = yield* createMail(Effect.succeed(parallelClient));
        const killedEvents = yield* startEvents(killedStackId);
        const parallelEvents = yield* startEvents(parallelStackId);
        yield* Effect.all(
          [
            startMail(Effect.succeed(killedClient), killedMail.id),
            startMail(Effect.succeed(parallelClient), parallelMail.id),
          ],
          { concurrency: 2 },
        );
        const killedId = yield* requireDocker([
          "ps",
          "--all",
          "--quiet",
          "--no-trunc",
          "--filter",
          `label=com.supabase.stack=${killedStackId}`,
        ]);
        const parallelId = yield* requireDocker([
          "ps",
          "--all",
          "--quiet",
          "--no-trunc",
          "--filter",
          `label=com.supabase.stack=${parallelStackId}`,
        ]);
        expect(killedMail.id.length).toBeGreaterThan(0);
        expect(parallelMail.id.length).toBeGreaterThan(0);
        expect(killedId.length).toBeGreaterThan(0);
        expect(parallelId.length).toBeGreaterThan(0);
        const killedGeneration = yield* requireDocker([
          "inspect",
          "--format",
          '{{ index .Config.Labels "com.supabase.host-generation" }}',
          killedId,
        ]);
        const parallelGeneration = yield* requireDocker([
          "inspect",
          "--format",
          '{{ index .Config.Labels "com.supabase.host-generation" }}',
          parallelId,
        ]);
        expect(killedGeneration).toMatch(/^[a-f0-9-]+$/u);
        expect(parallelGeneration).toMatch(/^[a-f0-9-]+$/u);
        expect(parallelGeneration).not.toBe(killedGeneration);
        expect(yield* inspectRunning(killedId)).toBe("true");
        expect(yield* inspectRunning(parallelId)).toBe("true");

        yield* awaitEvent(killedEvents, "start", killedId);
        yield* awaitEvent(parallelEvents, "start", parallelId);
        process.kill(killedHost.endpoint.pid, "SIGKILL");
        killedHost.stopped = true;
        yield* waitForOwnerExit(killedHost.endpoint.pid);
        yield* awaitEvent(killedEvents, "destroy", killedId);
        yield* assertAbsent(killedId);
        expect(yield* inspectRunning(parallelId)).toBe("true");

        yield* parallelClient.shutdown({ destroy: true });
        parallelHost.stopped = true;
        yield* waitForOwnerExit(parallelHost.endpoint.pid);
        yield* awaitEvent(parallelEvents, "destroy", parallelId);
        yield* assertAbsent(parallelId);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp))),
);
