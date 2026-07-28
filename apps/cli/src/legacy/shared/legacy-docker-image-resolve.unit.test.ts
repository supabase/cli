import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Sink, Stream } from "effect";
import type * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as TestClock from "effect/testing/TestClock";

import { legacyMakeDockerImageResolver } from "./legacy-docker-image-resolve.ts";
import { LEGACY_SUGGEST_DOCKER_INSTALL } from "./legacy-docker-suggest.ts";
import { LegacyDockerRunError } from "./legacy-docker-run.errors.ts";

const REGISTRY_ENV = "SUPABASE_INTERNAL_IMAGE_REGISTRY";

function mockSpawner(
  pullResults: ReadonlyArray<{ readonly exitCode: number; readonly stderr?: string }>,
  // Defaults to a non-zero exit with empty stderr, which forces every
  // candidate through the pull path instead of the already-cached shortcut —
  // the behavior both existing pull-retry tests below rely on. A test
  // covering `hasLocalImage`'s own fail-fast behavior overrides this to
  // simulate a daemon-down `image inspect` response instead.
  imageInspectResult: { readonly exitCode: number; readonly stderr?: string } = { exitCode: 1 },
) {
  const pulls: Array<string> = [];
  const imageInspectOptions: Array<ChildProcess.CommandOptions> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args : [];

      if (args[0] === "image" && args[1] === "inspect") {
        if (command._tag === "StandardCommand") imageInspectOptions.push(command.options);
        const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        yield* Deferred.succeed(
          exitDeferred,
          ChildProcessSpawner.ExitCode(imageInspectResult.exitCode),
        );
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          stdout: Stream.empty,
          stderr:
            imageInspectResult.stderr !== undefined
              ? Stream.fromIterable([new TextEncoder().encode(imageInspectResult.stderr)])
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
    get imageInspectOptions() {
      return imageInspectOptions;
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
        // Records every chunk written to stderr, including the `docker pull` child's own
        // stdout/stderr, which `pullImage` tees live to the parent's stderr as `Uint8Array`
        // chunks — only the `Retrying after …` banner is ever written as a plain `string`, so
        // filtering by `typeof chunk === "string"` isolates the banner from the tee below.
        const stderrChunks: Array<unknown> = [];
        const originalWrite = globalThis.process.stderr.write.bind(globalThis.process.stderr);
        globalThis.process.stderr.write = ((chunk: unknown) => {
          stderrChunks.push(chunk);
          return true;
        }) as typeof globalThis.process.stderr.write;

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
          // `image inspect`'s stdout must be fully ignored — the default
          // `"pipe"` stdio risks a write-buffer deadlock on a cache hit (see
          // the doc comment in `legacy-docker-image-resolve.ts`) — but
          // stderr IS piped so a daemon-unreachable response can be told
          // apart from a genuine cache miss.
          expect(mock.imageInspectOptions.length).toBeGreaterThan(0);
          for (const options of mock.imageInspectOptions) {
            expect(options).toMatchObject({ stdin: "ignore", stdout: "ignore", stderr: "pipe" });
          }
          // Go's per-retry banner (`docker.go:314`): `Fprintf(os.Stderr, "Retrying after %v: %s\n", …)`
          // — one banner before each of the 2 retries, escalating 4s then 8s, naming the exact
          // candidate this resolver pinned to (see the comment above on `REGISTRY_ENV`).
          const retryBanners = stderrChunks.filter(
            (chunk): chunk is string =>
              typeof chunk === "string" && chunk.startsWith("Retrying after"),
          );
          expect(retryBanners).toEqual([
            "Retrying after 4s: supabase/postgres:17.6.1.138\n",
            "Retrying after 8s: supabase/postgres:17.6.1.138\n",
          ]);
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
        const stderrChunks: Array<unknown> = [];
        const originalWrite = globalThis.process.stderr.write.bind(globalThis.process.stderr);
        globalThis.process.stderr.write = ((chunk: unknown) => {
          stderrChunks.push(chunk);
          return true;
        }) as typeof globalThis.process.stderr.write;

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
          // Only the first candidate's failed attempt sleeps through a retry banner — the
          // second attempt succeeds immediately, so the 8s banner (and a third pull) must
          // never happen.
          const retryBanners = stderrChunks.filter(
            (chunk): chunk is string =>
              typeof chunk === "string" && chunk.startsWith("Retrying after"),
          );
          expect(retryBanners).toEqual(["Retrying after 4s: supabase/postgres:17.6.1.138\n"]);
        } finally {
          globalThis.process.stderr.write = originalWrite;
          if (previousRegistry === undefined) delete process.env[REGISTRY_ENV];
          else process.env[REGISTRY_ENV] = previousRegistry;
        }
      }),
  );

  it.effect("prints no Retrying banner when the first pull attempt succeeds", () =>
    Effect.gen(function* () {
      const previousRegistry = process.env[REGISTRY_ENV];
      process.env[REGISTRY_ENV] = "docker.io";
      const stderrChunks: Array<unknown> = [];
      const originalWrite = globalThis.process.stderr.write.bind(globalThis.process.stderr);
      globalThis.process.stderr.write = ((chunk: unknown) => {
        stderrChunks.push(chunk);
        return true;
      }) as typeof globalThis.process.stderr.write;

      try {
        const mock = mockSpawner([{ exitCode: 0 }]);
        const resolve = legacyMakeDockerImageResolver(mock.spawner);

        const image = yield* resolve("supabase/postgres:17.6.1.138");

        expect(mock.pulls).toHaveLength(1);
        expect(image).toBe("supabase/postgres:17.6.1.138");
        const retryBanners = stderrChunks.filter(
          (chunk): chunk is string =>
            typeof chunk === "string" && chunk.startsWith("Retrying after"),
        );
        expect(retryBanners).toEqual([]);
      } finally {
        globalThis.process.stderr.write = originalWrite;
        if (previousRegistry === undefined) delete process.env[REGISTRY_ENV];
        else process.env[REGISTRY_ENV] = previousRegistry;
      }
    }),
  );

  it.effect("fails fast on a daemon-unreachable image inspect without ever attempting a pull", () =>
    Effect.gen(function* () {
      const previousRegistry = process.env[REGISTRY_ENV];
      process.env[REGISTRY_ENV] = "docker.io";

      try {
        const daemonUnreachableStderr =
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";
        const mock = mockSpawner([], { exitCode: 1, stderr: daemonUnreachableStderr });
        const resolve = legacyMakeDockerImageResolver(mock.spawner);

        const error = yield* resolve("supabase/postgres:17.6.1.138").pipe(Effect.flip);

        expect(error).toBeInstanceOf(LegacyDockerRunError);
        expect(error.message).toContain(daemonUnreachableStderr);
        expect(error.message).toContain(LEGACY_SUGGEST_DOCKER_INSTALL);
        expect(mock.pulls).toHaveLength(0);
      } finally {
        if (previousRegistry === undefined) delete process.env[REGISTRY_ENV];
        else process.env[REGISTRY_ENV] = previousRegistry;
      }
    }),
  );
});
