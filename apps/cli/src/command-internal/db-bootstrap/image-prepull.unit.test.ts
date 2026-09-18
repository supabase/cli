import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Ref, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ImagePrepullError, ensureImagesCached } from "./image-prepull.ts";

/** Per-call variant of `docker-lifecycle.unit.test.ts`'s `mockSpawner`, so each argv can respond differently. */
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

describe("ensureImagesCached", () => {
  it.live("dedupes images before resolving, returning original ref -> resolved URL", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "image" && args[1] === "inspect") {
        const image = args[2];
        const cached =
          image === "public.ecr.aws/supabase/postgres:15" ||
          image === "public.ecr.aws/supabase/kong:3";
        // This stderr text is what `hasLocalImage` treats as a confirmed cache miss.
        return cached
          ? { exitCode: 0 }
          : { exitCode: 1, stderr: `Error response from daemon: No such image: ${image}` };
      }
      return { exitCode: 1 };
    });

    return ensureImagesCached(mock.spawner, [
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
              // A sequential implementation would hang here forever, since the second call
              // never starts until this one returns.
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

      const resolved = yield* ensureImagesCached(spawner, ["supabase/a:1", "supabase/b:1"]);
      expect(resolved.size).toBe(2);
    }),
  );

  // Every pull attempt fails, driving the real `DOCKER_PULL_RETRY_DELAYS_MS` backoff to
  // exhaustion across all 3 registry candidates (~36s) — needs more than Vitest's 5s default.
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

      return ensureImagesCached(mock.spawner, ["supabase/a:1", "supabase/b:1"]).pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error).toBeInstanceOf(ImagePrepullError);
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

      return ensureImagesCached(mock.spawner, ["supabase/a:1"]).pipe(
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
    return ensureImagesCached(mock.spawner, []).pipe(
      Effect.map((resolved) => {
        expect(resolved.size).toBe(0);
        expect(mock.spawned).toHaveLength(0);
      }),
    );
  });
});
