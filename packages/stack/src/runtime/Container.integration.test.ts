import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Crypto,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Ref,
  Sink,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcessSpawner as ChildProcessSpawnerService } from "effect/unstable/process/ChildProcessSpawner";
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

  it.live("reports a scope failure when stop fails and leaves cleanup authority", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const failStop = yield* Ref.make(true);
      const processRef = yield* Ref.make<Option.Option<ContainerProcess>>(Option.none());
      const spawner = makeStopFailureSpawner(delegate, failStop);
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `failed-stop-${token}`;
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* makeContainerRuntime({ engine: "docker" });
              yield* runtime.prepare(image);
              const process = yield* runtime.launch({
                image,
                stackId: "f".repeat(64),
                instanceId,
                env: {},
                args: [
                  "-e",
                  "process.on('SIGTERM', () => process.exit(0)); console.log('ready'); setInterval(() => {}, 1000)",
                ],
              });
              yield* Ref.set(processRef, Option.some(process));
              const logs = yield* ready(process);
              yield* Fiber.interrupt(logs);
            }),
          ).pipe(
            Effect.exit,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          expect(Exit.isFailure(result)).toBe(true);
          if (Exit.isFailure(result))
            expect(Cause.pretty(result.cause)).toContain("injected stop failure");
          const process = yield* Ref.get(processRef).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die("launch did not retain cleanup authority"),
                onSome: Effect.succeed,
              }),
            ),
          );
          expect(yield* running(process.id)).toBe(true);
          yield* Ref.set(failStop, false);
          yield* process.stop;
          yield* process.remove;
          expect(yield* exists(process.id)).toBe(false);
        }),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("recovers the container identity when create acknowledgement is interrupted", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `interrupted-create-${token}`;
      const acknowledged = yield* Deferred.make<void>();
      const createConsumed = yield* Ref.make(false);
      const spawner = makeCreateInterruptionSpawner(delegate, createConsumed, acknowledged);
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const id = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* makeContainerRuntime({ engine: "docker" });
              yield* runtime.prepare(image);
              const launch = yield* runtime
                .launch({
                  image,
                  stackId: "g".repeat(64),
                  instanceId,
                  env: {},
                  args: ["-e", "setInterval(() => {}, 1000)"],
                })
                .pipe(Effect.forkChild({ startImmediately: true }));
              yield* Deferred.await(acknowledged);
              yield* Fiber.interrupt(launch);
              const result = yield* Fiber.await(launch);
              expect(Exit.isFailure(result)).toBe(true);
              if (Exit.isSuccess(result)) return yield* Effect.die("launch unexpectedly succeeded");
              expect(Exit.hasInterrupts(result)).toBe(true);
              const ids = yield* idsByInstance(instanceId);
              expect(ids).toHaveLength(1);
              const [id] = ids;
              if (id === undefined)
                return yield* Effect.die("missing recovered container identity");
              expect(yield* exists(id)).toBe(true);
              return id;
            }),
          );
          expect(yield* exists(id)).toBe(false);
        }),
        removeByInstance(instanceId).pipe(Effect.orDie),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retains cleanup authority when create is cancelled before its result is exposed", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `pending-create-${token}`;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const present = yield* Ref.make(false);
      const spawner = makePendingCreateSpawner(delegate, started, release, present);
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeContainerRuntime({ engine: "docker" });
          yield* runtime.prepare(image);
          const launch = yield* runtime
            .launch({
              image,
              stackId: "h".repeat(64),
              instanceId,
              env: {},
              args: ["-e", "setInterval(() => {}, 1000)"],
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(started);
          yield* Effect.sync(() => launch.interruptUnsafe());
          yield* Ref.set(present, true);
          yield* Deferred.succeed(release, undefined);
          const result = yield* Fiber.await(launch);
          expect(Exit.isFailure(result)).toBe(true);
          expect(Exit.hasInterrupts(result)).toBe(true);
          return result;
        }),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* Ref.get(present)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retains cleanup authority when identity recovery fails", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `failed-recovery-${token}`;
      const acknowledged = yield* Deferred.make<void>();
      const createConsumed = yield* Ref.make(false);
      const failRecovery = yield* Ref.make(true);
      const spawner = makeCreateInterruptionSpawner(
        delegate,
        createConsumed,
        acknowledged,
        failRecovery,
      );
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* makeContainerRuntime({ engine: "docker" });
              yield* runtime.prepare(image);
              const result = yield* runtime
                .launch({
                  image,
                  stackId: "i".repeat(64),
                  instanceId,
                  env: {},
                  args: ["-e", "setInterval(() => {}, 1000)"],
                })
                .pipe(Effect.exit);
              yield* Ref.set(failRecovery, false);
              return result;
            }),
          ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
          if (Exit.isSuccess(result)) return yield* Effect.die("launch unexpectedly succeeded");
          const failure = Cause.findErrorOption(result.cause);
          if (Option.isNone(failure) || !(failure.value instanceof ContainerLaunchError))
            return yield* Effect.die("launch failure did not retain cleanup authority");
          expect(failure.value.failure.message).toContain("injected recovery failure");
          expect(yield* idsByInstance(instanceId)).toHaveLength(0);
        }),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retains a partial cleanup handle when recovery fails during scope close", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `retry-recovery-${token}`;
      const acknowledged = yield* Deferred.make<void>();
      const createConsumed = yield* Ref.make(false);
      const failRecovery = yield* Ref.make(true);
      const partialRef = yield* Ref.make<Option.Option<ContainerProcess>>(Option.none());
      const spawner = makeCreateInterruptionSpawner(
        delegate,
        createConsumed,
        acknowledged,
        failRecovery,
      );
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const scopeResult = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* makeContainerRuntime({ engine: "docker" });
              yield* runtime.prepare(image);
              const result = yield* runtime
                .launch({
                  image,
                  stackId: "j".repeat(64),
                  instanceId,
                  env: {},
                  args: ["-e", "setInterval(() => {}, 1000)"],
                })
                .pipe(Effect.exit);
              if (Exit.isFailure(result)) {
                const failure = Cause.findErrorOption(result.cause);
                if (Option.isSome(failure) && failure.value instanceof ContainerLaunchError)
                  yield* Ref.set(partialRef, Option.some(failure.value.process));
              }
              return result;
            }),
          ).pipe(
            Effect.exit,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          expect(Exit.isFailure(scopeResult)).toBe(true);
          if (Exit.isFailure(scopeResult))
            expect(Cause.pretty(scopeResult.cause)).toContain("injected recovery failure");
          const partial = yield* Ref.get(partialRef).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.die("launch failure did not retain cleanup authority"),
                onSome: Effect.succeed,
              }),
            ),
          );
          yield* Ref.set(failRecovery, false);
          yield* partial.remove;
          expect(yield* idsByInstance(instanceId)).toHaveLength(0);
        }),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const makeStopFailureSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  failStop: Ref.Ref<boolean>,
) =>
  ChildProcessSpawner.make((command) => {
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "stop"
    ) {
      return Effect.gen(function* () {
        if (!(yield* Ref.get(failStop))) return yield* delegate.spawn(command);
        return yield* delegate.spawn(
          ChildProcess.make(
            process.execPath,
            ["-e", "console.error('injected stop failure'); process.exit(1)"],
            { stdin: "ignore" },
          ),
        );
      });
    }
    return delegate.spawn(command);
  });

const makeCreateInterruptionSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  createConsumed: Ref.Ref<boolean>,
  acknowledged: Deferred.Deferred<void>,
  failRecovery?: Ref.Ref<boolean>,
) =>
  ChildProcessSpawner.make((command) => {
    if (
      failRecovery !== undefined &&
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "ps" &&
      command.args.some((arg) => arg.startsWith("name=^/?supabase-"))
    )
      return Effect.gen(function* () {
        if (!(yield* Ref.get(failRecovery))) return yield* delegate.spawn(command);
        return yield* delegate.spawn(
          ChildProcess.make(
            process.execPath,
            ["-e", "console.error('injected recovery failure'); process.exit(1)"],
            { stdin: "ignore" },
          ),
        );
      });
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "create"
    ) {
      return Effect.gen(function* () {
        if (yield* Ref.get(createConsumed)) return yield* delegate.spawn(command);
        yield* Ref.set(createConsumed, true);
        const cidfile = command.args.indexOf("--cidfile");
        if (cidfile < 0 || cidfile + 1 >= command.args.length)
          return yield* delegate.spawn(command);
        const args = command.args.filter((_, index) => index !== cidfile && index !== cidfile + 1);
        const created = yield* delegate.spawn(
          ChildProcess.make(command.command, args, command.options),
        );
        const exitCode = yield* created.exitCode;
        yield* Deferred.succeed(acknowledged, undefined);
        return ChildProcessSpawner.makeHandle({
          pid: created.pid,
          exitCode: Effect.succeed(exitCode),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        });
      });
    }
    return delegate.spawn(command);
  });

const makePendingCreateSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  started: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
  present: Ref.Ref<boolean>,
) =>
  ChildProcessSpawner.make((command) => {
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "ps" &&
      command.args.some((arg) => arg.startsWith("name=^/?supabase-"))
    ) {
      return Effect.succeed(successfulHandle());
    }
    if (!ChildProcess.isStandardCommand(command) || command.command !== "docker")
      return delegate.spawn(command);
    if (command.args[0] === "stop" || command.args[0] === "rm") {
      return Effect.gen(function* () {
        if (command.args[0] === "rm") yield* Ref.set(present, false);
        return successfulHandle();
      });
    }
    if (command.args[0] !== "create") return delegate.spawn(command);
    return Effect.gen(function* () {
      const cidfile = command.args.indexOf("--cidfile");
      yield* Deferred.succeed(started, undefined);
      if (cidfile < 0 || cidfile + 1 >= command.args.length)
        return yield* Effect.die("missing cidfile");
      const create = Deferred.await(release);
      const output = Stream.unwrap(
        Effect.gen(function* () {
          yield* create;
          return Stream.succeed(new TextEncoder().encode(`${pendingContainerId}\n`));
        }),
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: create.pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
        isRunning: create.pipe(Effect.as(false)),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: output,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      });
    });
  });

const pendingContainerId = "a".repeat(64);

const successfulHandle = () =>
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

const idsByInstance = (instanceId: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "docker",
        [
          "ps",
          "--all",
          "--quiet",
          "--no-trunc",
          "--filter",
          `label=com.supabase.instance=${instanceId}`,
        ],
        { stdin: "ignore" },
      ),
    );
    const output = yield* child.stdout.pipe(Stream.decodeText, Stream.mkString);
    return output
      .split("\n")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
  });

const removeByInstance = (instanceId: string) =>
  Effect.gen(function* () {
    const ids = yield* idsByInstance(instanceId);
    if (ids.length === 0) return;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("docker", ["rm", "--force", ...ids], { stdin: "ignore" }),
    );
    const [stderr, code] = yield* Effect.all([
      child.stderr.pipe(Stream.decodeText, Stream.mkString),
      child.exitCode,
    ]);
    if (Number(code) !== 0)
      return yield* new ContainerTestError({
        message: `docker rm exited with ${String(code)}`,
        cause: stderr.trim(),
      });
  });

const running = (id: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("docker", ["inspect", "--format", "{{.State.Running}}", id], {
        stdin: "ignore",
      }),
    );
    return (yield* child.stdout.pipe(Stream.decodeText, Stream.mkString)).trim() === "true";
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
