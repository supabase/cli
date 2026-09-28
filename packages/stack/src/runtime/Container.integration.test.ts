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
  it.live("recognizes a cached pinned image without pulling", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
      yield* runtime.prepare(image);
      const repositoryDigest = yield* repoDigest(delegate, image);
      const digest = repositoryDigest.slice(repositoryDigest.indexOf("@") + 1);
      expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      const pinnedImage = `${image}@${digest}`;
      const pullAttempted = yield* Ref.make(false);
      const spawner = makePullFailureSpawner(delegate, pullAttempted);
      yield* makeContainerRuntime({ engine: "docker", root: "." }).pipe(
        Effect.flatMap((runtime) => runtime.prepare(pinnedImage)),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      expect(yield* Ref.get(pullAttempted)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps missing image pull failures observable", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const pullAttempted = yield* Ref.make(false);
      const spawner = makePullFailureSpawner(delegate, pullAttempted);
      const result = yield* makeContainerRuntime({ engine: "docker", root: "." }).pipe(
        Effect.flatMap((runtime) =>
          runtime.prepare(`supabase-prepare-regression:${token}`).pipe(Effect.exit),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(yield* Ref.get(pullAttempted)).toBe(true);
      if (Exit.isFailure(result)) expect(Cause.pretty(result.cause)).toContain("pull rejected");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("prepares, launches, streams, waits, and removes one exact container", () =>
    Effect.gen(function* () {
      const id = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
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
          const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
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
          const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
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

  it.live("stops a container with its configured stop signal", () =>
    Effect.gen(function* () {
      const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
      yield* runtime.prepare(image);
      const process = yield* runtime.launch({
        image,
        stackId: "r".repeat(64),
        instanceId: "stop-signal",
        env: {},
        args: [
          "-e",
          "process.on('SIGINT', () => process.exit(3)); setInterval(() => {}, 1000); console.log('ready')",
        ],
        stopSignal: "SIGINT",
        stopGraceSeconds: 20,
      });
      const logs = yield* ready(process);

      yield* process.stop;
      expect(yield* process.exitCode).toBe(3);

      yield* process.remove;
      yield* Fiber.interrupt(logs);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("waits until a discarded container stops before returning", () =>
    Effect.gen(function* () {
      const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
      yield* runtime.prepare(image);
      const process = yield* runtime.launch({
        image,
        stackId: "f".repeat(64),
        instanceId: "discard-waits-for-stop",
        env: {},
        args: [
          "-e",
          "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 2000)); setInterval(() => {}, 1000); console.log('ready')",
        ],
      });
      const logs = yield* ready(process);

      yield* process.discard;
      expect(yield* running(process.id)).toBe(false);
      expect(yield* exists(process.id)).toBe(true);

      yield* process.remove;
      expect(yield* exists(process.id)).toBe(false);
      yield* Fiber.interrupt(logs);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("returns cleanup authority when container start fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
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
        const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
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

  it.live("treats an externally removed container as already stopped", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `externally-removed-${token}`;
      yield* Effect.ensuring(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
            yield* runtime.prepare(image);
            const process = yield* runtime.launch({
              image,
              stackId: "x".repeat(64),
              instanceId,
              env: {},
              args: ["-e", "setInterval(() => {}, 1000)"],
            });
            yield* removeExternally(process.id);
            yield* process.stop;
            yield* process.remove;
            expect(yield* exists(process.id)).toBe(false);
          }),
        ),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("confirms absence after the remove client loses its result", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `lost-remove-result-${token}`;
      const lostResult = yield* Ref.make(false);
      const spawner = makeLostRemoveResultSpawner(delegate, lostResult);
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
              yield* runtime.prepare(image);
              const process = yield* runtime.launch({
                image,
                stackId: "k".repeat(64),
                instanceId,
                env: {},
                args: ["-e", "setInterval(() => {}, 1000)"],
              });
              yield* process.stop;
              yield* process.remove;
            }),
          ).pipe(
            Effect.exit,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          expect(yield* Ref.get(lostResult)).toBe(true);
          expect(Exit.isSuccess(result)).toBe(true);
          expect(yield* idsByInstance(instanceId)).toHaveLength(0);
        }),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retains a remove failure for a still-present non-removing container", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `failed-remove-${token}`;
      const failed = yield* Ref.make(false);
      const spawner = makeRemoveFailureSpawner(delegate, failed);
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
              yield* runtime.prepare(image);
              const process = yield* runtime.launch({
                image,
                stackId: "l".repeat(64),
                instanceId,
                env: {},
                args: ["-e", "setInterval(() => {}, 1000)"],
              });
              yield* process.stop;
              const removeResult = yield* process.remove.pipe(Effect.exit);
              expect(Exit.isFailure(removeResult)).toBe(true);
              if (Exit.isFailure(removeResult))
                expect(Cause.pretty(removeResult.cause)).toContain("injected remove failure");
              expect(yield* exists(process.id)).toBe(true);
            }),
          ).pipe(
            Effect.exit,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          expect(yield* Ref.get(failed)).toBe(true);
          expect(Exit.isSuccess(result)).toBe(true);
          expect(yield* idsByInstance(instanceId)).toHaveLength(0);
        }),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retains both remove and reconciliation failures", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `failed-reconciliation-${token}`;
      const failed = yield* Ref.make(false);
      const failProbe = yield* Ref.make(true);
      const spawner = makeRemoveFailureSpawner(delegate, failed, failProbe);
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
              yield* runtime.prepare(image);
              const process = yield* runtime.launch({
                image,
                stackId: "m".repeat(64),
                instanceId,
                env: {},
                args: ["-e", "setInterval(() => {}, 1000)"],
              });
              yield* process.stop;
              const removeResult = yield* process.remove.pipe(Effect.exit);
              expect(Exit.isFailure(removeResult)).toBe(true);
              if (Exit.isFailure(removeResult)) {
                const diagnostic = Cause.pretty(removeResult.cause);
                expect(diagnostic).toContain("injected remove failure");
                expect(diagnostic).toContain("injected reconciliation failure");
              }
            }),
          ).pipe(
            Effect.exit,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          expect(yield* Ref.get(failed)).toBe(true);
          expect(Exit.isSuccess(result)).toBe(true);
          expect(yield* idsByInstance(instanceId)).toHaveLength(0);
        }),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("waits for a real removal observed as removing", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `pending-remove-${token}`;
      const pendingProbes = yield* Ref.make(2);
      const lostResult = yield* Ref.make(false);
      const spawner = makePendingRemoveSpawner(delegate, pendingProbes, lostResult);
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
              yield* runtime.prepare(image);
              const process = yield* runtime.launch({
                image,
                stackId: "n".repeat(64),
                instanceId,
                env: {},
                args: ["-e", "setInterval(() => {}, 1000)"],
              });
              yield* process.stop;
              yield* process.remove;
            }),
          ).pipe(
            Effect.exit,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          expect(yield* Ref.get(lostResult)).toBe(true);
          expect(yield* Ref.get(pendingProbes)).toBe(0);
          expect(Exit.isSuccess(result)).toBe(true);
          expect(yield* idsByInstance(instanceId)).toHaveLength(0);
        }),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retains the remove failure when removing never reaches absence", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `stalled-remove-${token}`;
      const pendingProbes = yield* Ref.make(Number.POSITIVE_INFINITY);
      const lostResult = yield* Ref.make(false);
      const spawner = makePendingRemoveSpawner(delegate, pendingProbes, lostResult);
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
              yield* runtime.prepare(image);
              const process = yield* runtime.launch({
                image,
                stackId: "p".repeat(64),
                instanceId,
                env: {},
                args: ["-e", "setInterval(() => {}, 1000)"],
              });
              yield* process.stop;
              const removeResult = yield* process.remove.pipe(Effect.exit);
              expect(Exit.isFailure(removeResult)).toBe(true);
              if (Exit.isFailure(removeResult)) {
                const diagnostic = Cause.pretty(removeResult.cause);
                expect(diagnostic).toContain("Engine exited with 73");
                expect(diagnostic).toContain("TimeoutError");
              }
              expect(yield* exists(process.id)).toBe(false);
              yield* Ref.set(pendingProbes, 0);
              yield* process.remove;
            }),
          ).pipe(
            Effect.exit,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          expect(yield* Ref.get(lostResult)).toBe(true);
          expect(Exit.isSuccess(result)).toBe(true);
          expect(yield* idsByInstance(instanceId)).toHaveLength(0);
        }),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("preserves caller interruption and reconciles during scope close", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `interrupted-remove-${token}`;
      const completed = yield* Deferred.make<void>();
      const consumed = yield* Ref.make(false);
      const spawner = makeInterruptedRemoveSpawner(delegate, consumed, completed);
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
              yield* runtime.prepare(image);
              const process = yield* runtime.launch({
                image,
                stackId: "o".repeat(64),
                instanceId,
                env: {},
                args: ["-e", "setInterval(() => {}, 1000)"],
              });
              yield* process.stop;
              const remover = yield* process.remove.pipe(
                Effect.forkChild({ startImmediately: true }),
              );
              yield* Deferred.await(completed);
              expect(yield* exists(process.id)).toBe(false);
              yield* Fiber.interrupt(remover);
              expect(Exit.hasInterrupts(yield* Fiber.await(remover))).toBe(true);
            }),
          ).pipe(
            Effect.exit,
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          expect(yield* Ref.get(consumed)).toBe(true);
          expect(Exit.isSuccess(result)).toBe(true);
          expect(yield* idsByInstance(instanceId)).toHaveLength(0);
        }),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
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
              const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
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

  it.live("retains cleanup authority when create reports failure after creating a container", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `failed-create-after-commit-${token}`;
      const created = yield* Ref.make(false);
      const spawner = makeCreateFailureSpawner(delegate, created, true);
      yield* Effect.ensuring(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
            yield* runtime.prepare(image);
            const result = yield* runtime
              .launch({
                image,
                stackId: "g".repeat(64),
                instanceId,
                env: {},
                args: ["-e", "setInterval(() => {}, 1000)"],
              })
              .pipe(Effect.exit);
            if (Exit.isSuccess(result)) return yield* Effect.die("launch unexpectedly succeeded");
            const failure = Cause.findErrorOption(result.cause);
            if (Option.isNone(failure) || !(failure.value instanceof ContainerLaunchError))
              return yield* Effect.die("launch failure did not retain cleanup authority");
            expect(failure.value.failure.message).toContain("injected create failure");
            expect(failure.value.failure.message).toContain("container name supabase-");
            expect(yield* Ref.get(created)).toBe(true);
            expect(yield* idsByInstance(instanceId)).toHaveLength(1);
            yield* failure.value.process.stop;
            yield* failure.value.process.remove;
            expect(yield* idsByInstance(instanceId)).toHaveLength(0);
          }),
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retains cleanup authority when create fails without creating a container", () =>
    Effect.gen(function* () {
      const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const token = yield* crypto.randomUUIDv4;
      const instanceId = `failed-create-empty-${token}`;
      const created = yield* Ref.make(false);
      const spawner = makeCreateFailureSpawner(delegate, created, false);
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const result = yield* Effect.scoped(
            Effect.gen(function* () {
              const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
              yield* runtime.prepare(image);
              return yield* runtime
                .launch({
                  image,
                  stackId: "q".repeat(64),
                  instanceId,
                  env: {},
                  args: ["-e", "setInterval(() => {}, 1000)"],
                })
                .pipe(Effect.exit);
            }),
          ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
          if (Exit.isSuccess(result)) return yield* Effect.die("launch unexpectedly succeeded");
          const failure = Cause.findErrorOption(result.cause);
          if (Option.isNone(failure) || !(failure.value instanceof ContainerLaunchError))
            return yield* Effect.die("launch failure did not retain cleanup authority");
          expect(failure.value.failure.message).toContain("injected create failure");
          expect(yield* Ref.get(created)).toBe(false);
          yield* failure.value.process.stop;
          yield* failure.value.process.remove;
          expect(yield* idsByInstance(instanceId)).toHaveLength(0);
        }),
        removeByInstance(instanceId).pipe(Effect.orDie),
      );
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
          const runtime = yield* makeContainerRuntime({ engine: "docker", root: "." });
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
});

const repoDigest = (spawner: ChildProcessSpawnerService["Service"], image: string) =>
  Effect.gen(function* () {
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "docker",
        ["image", "inspect", "--format", "{{range .RepoDigests}}{{println .}}{{end}}", image],
        { stdin: "ignore" },
      ),
    );
    const [stdout, stderr, code] = yield* Effect.all([
      child.stdout.pipe(Stream.decodeText, Stream.mkString),
      child.stderr.pipe(Stream.decodeText, Stream.mkString),
      child.exitCode,
    ]);
    if (Number(code) !== 0)
      return yield* new ContainerTestError({
        message: `docker image inspect exited with ${String(code)}`,
        cause: stderr.trim(),
      });
    const digest = stdout
      .split("\n")
      .map((value) => value.trim())
      .find((value) => value.includes("@sha256:"));
    if (digest === undefined)
      return yield* new ContainerTestError({
        message: `docker image inspect returned no repository digest for ${image}`,
      });
    return digest;
  });

const makePullFailureSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  pullAttempted: Ref.Ref<boolean>,
) =>
  ChildProcessSpawner.make((command) => {
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "pull"
    )
      return Effect.gen(function* () {
        yield* Ref.set(pullAttempted, true);
        return yield* delegate.spawn(
          ChildProcess.make(
            process.execPath,
            ["-e", "console.error('pull rejected by cached-image regression'); process.exit(73)"],
            { stdin: "ignore" },
          ),
        );
      });
    return delegate.spawn(command);
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

const makeLostRemoveResultSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  lostResult: Ref.Ref<boolean>,
) =>
  ChildProcessSpawner.make((command) => {
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "rm"
    ) {
      return Effect.gen(function* () {
        if (yield* Ref.get(lostResult)) return yield* delegate.spawn(command);
        yield* Ref.set(lostResult, true);
        const child = yield* delegate.spawn(command);
        return ChildProcessSpawner.makeHandle({
          pid: child.pid,
          exitCode: child.exitCode.pipe(Effect.as(ChildProcessSpawner.ExitCode(73))),
          isRunning: child.isRunning,
          kill: child.kill,
          stdin: child.stdin,
          stdout: child.stdout,
          stderr: child.stderr,
          all: child.all,
          getInputFd: child.getInputFd,
          getOutputFd: child.getOutputFd,
          unref: child.unref,
        });
      });
    }
    return delegate.spawn(command);
  });

const makeRemoveFailureSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  failed: Ref.Ref<boolean>,
  failProbe?: Ref.Ref<boolean>,
) =>
  ChildProcessSpawner.make((command) => {
    if (
      failProbe !== undefined &&
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "ps" &&
      command.args.some((arg) => arg.startsWith("name=^/?"))
    ) {
      return Effect.gen(function* () {
        if (!(yield* Ref.get(failProbe))) return yield* delegate.spawn(command);
        yield* Ref.set(failProbe, false);
        return yield* delegate.spawn(
          ChildProcess.make(
            process.execPath,
            ["-e", "console.error('injected reconciliation failure'); process.exit(1)"],
            { stdin: "ignore" },
          ),
        );
      });
    }
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "rm"
    ) {
      return Effect.gen(function* () {
        if (yield* Ref.get(failed)) return yield* delegate.spawn(command);
        yield* Ref.set(failed, true);
        return yield* delegate.spawn(
          ChildProcess.make(
            process.execPath,
            ["-e", "console.error('injected remove failure'); process.exit(1)"],
            { stdin: "ignore" },
          ),
        );
      });
    }
    return delegate.spawn(command);
  });

const makePendingRemoveSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  pendingProbes: Ref.Ref<number>,
  lostResult: Ref.Ref<boolean>,
) =>
  ChildProcessSpawner.make((command) => {
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "ps" &&
      command.args.some((arg) => arg.startsWith("name=^/?"))
    ) {
      return Effect.gen(function* () {
        const remaining = yield* Ref.get(pendingProbes);
        if (remaining === 0) return yield* delegate.spawn(command);
        yield* Ref.set(pendingProbes, remaining - 1);
        return yield* delegate.spawn(
          ChildProcess.make(process.execPath, ["-e", "process.stdout.write('removing\\n')"], {
            stdin: "ignore",
          }),
        );
      });
    }
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "rm"
    ) {
      return Effect.gen(function* () {
        if (yield* Ref.get(lostResult)) return yield* delegate.spawn(command);
        yield* Ref.set(lostResult, true);
        const child = yield* delegate.spawn(command);
        return ChildProcessSpawner.makeHandle({
          pid: child.pid,
          exitCode: child.exitCode.pipe(Effect.as(ChildProcessSpawner.ExitCode(73))),
          isRunning: child.isRunning,
          kill: child.kill,
          stdin: child.stdin,
          stdout: child.stdout,
          stderr: child.stderr,
          all: child.all,
          getInputFd: child.getInputFd,
          getOutputFd: child.getOutputFd,
          unref: child.unref,
        });
      });
    }
    return delegate.spawn(command);
  });

const makeInterruptedRemoveSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  consumed: Ref.Ref<boolean>,
  completed: Deferred.Deferred<void>,
) =>
  ChildProcessSpawner.make((command) => {
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "rm"
    ) {
      return Effect.gen(function* () {
        if (yield* Ref.get(consumed)) return yield* delegate.spawn(command);
        yield* Ref.set(consumed, true);
        const child = yield* delegate.spawn(command);
        return ChildProcessSpawner.makeHandle({
          pid: child.pid,
          exitCode: child.exitCode.pipe(
            Effect.tap(() => Deferred.succeed(completed, undefined)),
            Effect.andThen(Effect.never),
          ),
          isRunning: child.isRunning,
          kill: child.kill,
          stdin: child.stdin,
          stdout: child.stdout,
          stderr: child.stderr,
          all: child.all,
          getInputFd: child.getInputFd,
          getOutputFd: child.getOutputFd,
          unref: child.unref,
        });
      });
    }
    return delegate.spawn(command);
  });

const makeCreateFailureSpawner = (
  delegate: ChildProcessSpawnerService["Service"],
  created: Ref.Ref<boolean>,
  createResource: boolean,
) =>
  ChildProcessSpawner.make((command) => {
    if (
      ChildProcess.isStandardCommand(command) &&
      command.command === "docker" &&
      command.args[0] === "create"
    ) {
      return Effect.gen(function* () {
        if (createResource) {
          const actual = yield* delegate.spawn(command);
          const code = yield* actual.exitCode;
          expect(Number(code)).toBe(0);
          yield* Ref.set(created, true);
        }
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(0),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.make(new TextEncoder().encode("injected create failure\n")),
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
      yield* Deferred.succeed(started, undefined);
      const create = Deferred.await(release);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(0),
        exitCode: create.pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
        isRunning: create.pipe(Effect.as(false)),
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
  });

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

const removeExternally = (id: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("docker", ["rm", "--force", id], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    const code = yield* child.exitCode;
    if (Number(code) !== 0)
      return yield* new ContainerTestError({
        message: `docker rm --force exited with ${String(code)}`,
      });
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
      ChildProcess.make("docker", ["inspect", "--format={{.State.Running}}", id], {
        stdin: "ignore",
      }),
    );
    const [output, exitCode] = yield* Effect.all(
      [child.stdout.pipe(Stream.decodeText, Stream.mkString), child.exitCode],
      { concurrency: "unbounded" },
    );
    expect(Number(exitCode)).toBe(0);
    return output.trim() === "true";
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
