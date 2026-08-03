import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Ref, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { LegacyImagePrepullError, legacyEnsureImagesCached } from "./image-prepull.ts";

/** Matches the standing `mockSpawner` shape in `legacy-docker-lifecycle.unit.test.ts`, generalized to a per-call handler so each argv can respond differently (needed for "some images cached, others not"). */
function mockSpawner(
  handler: (args: ReadonlyArray<string>) => { exitCode: number; stdout?: string; stderr?: string },
) {
  const encoder = new TextEncoder();
  const spawned: Array<ReadonlyArray<string>> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args : [];
      spawned.push(args);
      const result = handler(args);

      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(result.exitCode));

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.fromIterable(
          result.stdout !== undefined ? [encoder.encode(result.stdout)] : [],
        ),
        stderr: Stream.fromIterable(
          result.stderr !== undefined ? [encoder.encode(result.stderr)] : [],
        ),
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
    get spawned() {
      return spawned;
    },
  };
}

describe("legacyEnsureImagesCached", () => {
  it.live("dedupes images before resolving, returning original ref -> resolved URL", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "image" && args[1] === "inspect") {
        const image = args[2];
        const cached =
          image === "public.ecr.aws/supabase/postgres:15" ||
          image === "public.ecr.aws/supabase/kong:3";
        // A confirmed "no such image" (not merely a non-zero exit) is what tells
        // `hasLocalImage` this candidate is a genuine cache miss rather than some other
        // inspect failure, which now fails fast instead of falling through to a pull.
        return cached
          ? { exitCode: 0 }
          : { exitCode: 1, stderr: `Error response from daemon: No such image: ${image}` };
      }
      return { exitCode: 1 };
    });

    return legacyEnsureImagesCached(mock.spawner, [
      "supabase/postgres:15",
      "supabase/kong:3",
      "supabase/postgres:15",
    ]).pipe(
      Effect.map((resolved) => {
        expect(resolved).toEqual(
          new Map([
            ["supabase/postgres:15", "public.ecr.aws/supabase/postgres:15"],
            ["supabase/kong:3", "public.ecr.aws/supabase/kong:3"],
          ]),
        );
        // One `image inspect` call per UNIQUE image, not one per (duplicated) input entry.
        const inspectCalls = mock.spawned.filter(
          (call) => call[0] === "image" && call[1] === "inspect",
        );
        expect(inspectCalls).toHaveLength(2);
      }),
    );
  });

  it.live("resolves every image concurrently rather than one at a time", () =>
    Effect.gen(function* () {
      const started = yield* Ref.make(0);
      const bothStarted = yield* Deferred.make<void>();

      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const args = command._tag === "StandardCommand" ? command.args : [];
          if (args[0] === "image" && args[1] === "inspect") {
            const count = yield* Ref.updateAndGet(started, (n) => n + 1);
            if (count < 2) {
              // A sequential (non-concurrent) implementation would never let the
              // second image's `image inspect` call start until this one
              // returns, so awaiting here would hang forever — proving
              // concurrency is what lets this test complete at all.
              yield* Deferred.await(bothStarted);
            } else {
              yield* Deferred.succeed(bothStarted, undefined);
            }
          }
          const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(0));
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
        }),
      );

      const resolved = yield* legacyEnsureImagesCached(spawner, ["supabase/a:1", "supabase/b:1"]);
      expect(resolved.size).toBe(2);
    }),
  );

  // Every pull attempt fails, so this drives the real LEGACY_DOCKER_PULL_RETRY_DELAYS_MS
  // backoff (4s + 8s) to exhaustion across all 3 registry candidates (~36s) —
  // needs more than Vitest's 5s default.
  it.live(
    "aggregates every failed image's message into one combined error",
    () => {
      const mock = mockSpawner((args) => {
        if (args[0] === "image" && args[1] === "inspect") {
          return {
            exitCode: 1,
            stderr: `Error response from daemon: No such image: ${args[2]}`,
          };
        }
        if (args[0] === "pull") return { exitCode: 1, stderr: `no such image: ${args[1]}\n` };
        return { exitCode: 1 };
      });

      return legacyEnsureImagesCached(mock.spawner, ["supabase/a:1", "supabase/b:1"]).pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error).toBeInstanceOf(LegacyImagePrepullError);
          expect(error.message).toContain("supabase/a:1");
          expect(error.message).toContain("supabase/b:1");
        }),
      );
    },
    60_000,
  );

  it.live(
    "appends the install hint once when a failure indicates the daemon is unreachable",
    () => {
      const mock = mockSpawner((args) => {
        if (args[0] === "image" && args[1] === "inspect") {
          return {
            exitCode: 1,
            stderr: `Error response from daemon: No such image: ${args[2]}`,
          };
        }
        if (args[0] === "pull") {
          return {
            exitCode: 1,
            stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock\n",
          };
        }
        return { exitCode: 1 };
      });

      return legacyEnsureImagesCached(mock.spawner, ["supabase/a:1"]).pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error.message).toContain("Docker Desktop is a prerequisite for local development");
        }),
      );
    },
    60_000,
  );

  it.live("resolves an empty map for an empty image list without spawning anything", () => {
    const mock = mockSpawner(() => ({ exitCode: 0 }));
    return legacyEnsureImagesCached(mock.spawner, []).pipe(
      Effect.map((resolved) => {
        expect(resolved.size).toBe(0);
        expect(mock.spawned).toHaveLength(0);
      }),
    );
  });
});
