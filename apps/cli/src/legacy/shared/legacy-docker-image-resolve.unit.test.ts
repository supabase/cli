import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as TestClock from "effect/testing/TestClock";

import { legacyMakeDockerImageResolver } from "./legacy-docker-image-resolve.ts";

const REGISTRY_ENV = "SUPABASE_INTERNAL_IMAGE_REGISTRY";

function mockSpawner(
  pullResults: ReadonlyArray<{ readonly exitCode: number; readonly stderr?: string }>,
) {
  const pulls: Array<string> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args : [];

      if (args[0] === "image" && args[1] === "inspect") {
        // Force every candidate through the pull path instead of the
        // already-cached shortcut.
        const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(1));
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          exitCode: Deferred.await(exitDeferred),
          isRunning: Effect.succeed(false),
          stdin: Sink.drain,
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }

      const result = pulls.length < pullResults.length ? pullResults[pulls.length] : undefined;
      pulls.push(args[1] ?? "");
      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(result?.exitCode ?? 1));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.empty,
        stderr:
          result?.stderr !== undefined
            ? Stream.fromIterable([new TextEncoder().encode(result.stderr)])
            : Stream.empty,
        all: Stream.empty,
        exitCode: Deferred.await(exitDeferred),
        isRunning: Effect.succeed(false),
        stdin: Sink.drain,
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  return {
    spawner,
    get pulls() {
      return pulls;
    },
  };
}

describe("legacyMakeDockerImageResolver", () => {
  it.effect(
    "retries a pull failure unconditionally through messages that wouldn't have matched the old retryable-pattern allowlist, giving up after 3 total attempts",
    () =>
      Effect.gen(function* () {
        // Pins the resolver to a single registry candidate (the image
        // unchanged) so the assertions below cover exactly one candidate's
        // attempt count, rather than the full ECR/GHCR/Docker Hub fallback
        // list built by `legacyGetRegistryImageUrlCandidates`.
        const previousRegistry = process.env[REGISTRY_ENV];
        process.env[REGISTRY_ENV] = "docker.io";
        const originalWrite = globalThis.process.stderr.write.bind(globalThis.process.stderr);
        globalThis.process.stderr.write = (() => true) as typeof globalThis.process.stderr.write;

        try {
          // Mirrors Go's own `docker_test.go` "throws error on failure to pull
          // image" case: a bare, non-pattern-matching message (no
          // "toomanyrequests"/"rate exceeded"/etc.) still exhausts every
          // retry, because Go's `DockerImagePullWithRetry` retries on any
          // non-nil error, with no message classification at all.
          const mock = mockSpawner([
            { exitCode: 1, stderr: "no space left on device" },
            { exitCode: 1, stderr: "no space left on device" },
            { exitCode: 1, stderr: "no space left on device" },
          ]);
          const resolve = legacyMakeDockerImageResolver(mock.spawner);
          const fiber = yield* resolve("supabase/postgres:17.6.1.138").pipe(
            Effect.forkChild({ startImmediately: true }),
          );

          // 2 retries after the initial attempt, with Go's escalating 4s/8s
          // backoff (`2<<(i+1)` seconds for i=0,1) between them.
          yield* TestClock.adjust("4 seconds");
          yield* TestClock.adjust("8 seconds");
          const error = yield* Fiber.join(fiber).pipe(Effect.flip);

          expect(mock.pulls).toHaveLength(3);
          expect(error.message).toContain("no space left on device");
          expect(error.message).toContain("attempt 3");
        } finally {
          globalThis.process.stderr.write = originalWrite;
          if (previousRegistry === undefined) delete process.env[REGISTRY_ENV];
          else process.env[REGISTRY_ENV] = previousRegistry;
        }
      }),
  );

  it.effect(
    "resolves successfully once a retried pull succeeds, without waiting for the second backoff",
    () =>
      Effect.gen(function* () {
        const previousRegistry = process.env[REGISTRY_ENV];
        process.env[REGISTRY_ENV] = "docker.io";
        const originalWrite = globalThis.process.stderr.write.bind(globalThis.process.stderr);
        globalThis.process.stderr.write = (() => true) as typeof globalThis.process.stderr.write;

        try {
          const mock = mockSpawner([
            { exitCode: 1, stderr: "no space left on device" },
            { exitCode: 0 },
          ]);
          const resolve = legacyMakeDockerImageResolver(mock.spawner);
          const fiber = yield* resolve("supabase/postgres:17.6.1.138").pipe(
            Effect.forkChild({ startImmediately: true }),
          );

          yield* TestClock.adjust("4 seconds");
          const image = yield* Fiber.join(fiber);

          expect(mock.pulls).toHaveLength(2);
          expect(image).toBe("supabase/postgres:17.6.1.138");
        } finally {
          globalThis.process.stderr.write = originalWrite;
          if (previousRegistry === undefined) delete process.env[REGISTRY_ENV];
          else process.env[REGISTRY_ENV] = previousRegistry;
        }
      }),
  );
});
