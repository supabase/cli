import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Data, Deferred, Effect, Exit, Fiber, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";
import { ContainerLaunchError, makeContainerRuntime, type ContainerProcess } from "./Container.ts";

const image = "oven/bun:1.4.1-slim";

class ContainerTestError extends Data.TaggedError("ContainerTestError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

describe("container process adapter", () => {
  it.live("prepares, launches, streams, waits, and removes one exact container", () =>
    Effect.gen(function* () {
      const id = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeContainerRuntime({ engine: "docker" });
          yield* runtime.prepare(image);
          const process = yield* runtime.launch({
            image,
            stackId: "a".repeat(64),
            instanceId: "fixture-output",
            env: { FIXTURE: "true" },
            args: [
              "-e",
              "console.log('stdout-marker'); console.error('stderr-marker'); process.exit(7)",
            ],
          });
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              process.stdout.pipe(Stream.decodeText, Stream.mkString),
              process.stderr.pipe(Stream.decodeText, Stream.mkString),
              process.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          expect(stdout).toContain("stdout-marker");
          expect(stderr).toContain("stderr-marker");
          expect(exitCode).toBe(7);
          return process.id;
        }),
      );
      expect(yield* exists(id)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("streams tool input and output and preserves a nonzero exit", () =>
    Effect.gen(function* () {
      const id = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeContainerRuntime({ engine: "docker" });
          yield* runtime.prepare(image);
          const process = yield* runtime.launchTool({
            image,
            stackId: "e".repeat(64),
            instanceId: "tool-input",
            env: {},
            args: [
              "-e",
              "const input = await Bun.stdin.text(); console.log(input); console.error('tool-error'); process.exit(7)",
            ],
          });
          const [, stdout, stderr, exitCode] = yield* Effect.all(
            [
              Stream.make(new TextEncoder().encode("attached-input")).pipe(
                Stream.run(process.stdin),
              ),
              process.stdout.pipe(Stream.decodeText, Stream.mkString),
              process.stderr.pipe(Stream.decodeText, Stream.mkString),
              process.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          expect(stdout).toContain("attached-input");
          expect(stderr).toContain("tool-error");
          expect(exitCode).toBe(7);
          return process.id;
        }),
      );
      expect(yield* exists(id)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "publishes two private ports and keeps the second service alive after the first stops",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeContainerRuntime({ engine: "docker" });
          yield* runtime.prepare(image);
          const launch = (instanceId: string, marker: string) =>
            runtime.launch({
              image,
              stackId: "b".repeat(64),
              instanceId,
              env: {},
              ports: [8080],
              args: [
                "-e",
                `process.on('SIGTERM', () => process.exit(0)); Bun.serve({ hostname: '0.0.0.0', port: 8080, fetch() { return new Response(${JSON.stringify(marker)}) } }); console.log('ready')`,
              ],
            });
          const first = yield* launch("http-one", "one");
          const firstReady = yield* ready(first);
          const second = yield* launch("http-two", "two");
          const secondReady = yield* ready(second);
          expect(first.ports[8080]).toBeDefined();
          expect(second.ports[8080]).toBeDefined();
          expect(first.ports[8080]).not.toBe(second.ports[8080]);
          expect(yield* get(first.ports[8080])).toBe("one");
          expect(yield* get(second.ports[8080])).toBe("two");
          yield* first.stop;
          yield* first.remove;
          expect(yield* get(second.ports[8080])).toBe("two");
          yield* second.stop;
          yield* second.remove;
          yield* Fiber.interrupt(firstReady);
          yield* Fiber.interrupt(secondReady);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("returns cleanup authority when container start fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeContainerRuntime({ engine: "docker" });
        yield* runtime.prepare(image);
        const result = yield* runtime
          .launch({
            image,
            stackId: "c".repeat(64),
            instanceId: "invalid-entrypoint",
            env: {},
            entrypoint: "/definitely/missing/entrypoint",
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isSuccess(result))
          return yield* Effect.die("invalid entrypoint unexpectedly started");
        const failure = Cause.findErrorOption(result.cause);
        expect(Option.isSome(failure) && failure.value instanceof ContainerLaunchError).toBe(true);
        if (Option.isNone(failure) || !(failure.value instanceof ContainerLaunchError))
          return yield* Effect.die("launch failure did not retain cleanup authority");
        const id = failure.value.process.id;
        yield* failure.value.process.remove;
        expect(yield* exists(id)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps exit observation shared after a caller cancels its wait", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeContainerRuntime({ engine: "docker" });
        yield* runtime.prepare(image);
        const process = yield* runtime.launch({
          image,
          stackId: "d".repeat(64),
          instanceId: "cancelled-waiter",
          env: {},
          args: [
            "-e",
            "process.on('SIGTERM', () => process.exit(23)); setInterval(() => {}, 1000); console.log('ready')",
          ],
        });
        const logs = yield* ready(process);
        const waiter = yield* process.exitCode.pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.interrupt(waiter);
        expect(Exit.hasInterrupts(yield* Fiber.await(waiter))).toBe(true);
        yield* process.stop;
        expect(yield* process.exitCode).toBe(23);
        yield* Fiber.interrupt(logs);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

const ready = (process: ContainerProcess) =>
  Effect.gen(function* () {
    const signal = yield* Deferred.make<void>();
    const observer = yield* process.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((chunk) =>
        chunk === "ready" ? Deferred.succeed(signal, undefined) : Effect.void,
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(signal);
    return observer;
  });

const exists = (id: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("docker", ["inspect", id], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    return Number(yield* child.exitCode) === 0;
  });

const get = (port: number | undefined, path = "/") => {
  if (port === undefined)
    return Effect.fail(new ContainerTestError({ message: "container port was not assigned" }));
  return Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`http://127.0.0.1:${port}${path}`);
    return yield* response.text;
  }).pipe(
    Effect.mapError(
      (cause) => new ContainerTestError({ message: "container request failed", cause }),
    ),
    Effect.provide(NodeHttpClient.layerNodeHttp),
  );
};
