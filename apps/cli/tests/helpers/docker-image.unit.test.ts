import { describe, expect, it } from "@effect/vitest";
import { Data, Deferred, Effect, Exit, Fiber, Layer, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ensureImage, RESOLVE_BUDGET_MS, resolveDeadline, resolveImage } from "./docker-image.ts";

/** Matches the standing `mockSpawner` shape in `image-prepull.unit.test.ts`. */
function mockSpawner(
  handler: (args: ReadonlyArray<string>) => {
    exitCode: number;
    stdout?: string;
    stderr?: string;
    hang?: boolean;
  },
) {
  const encoder = new TextEncoder();
  const spawned: Array<ReadonlyArray<string>> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args : [];
      spawned.push(args);
      const result = handler(args);

      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      // `hang: true` leaves the deferred unresolved, standing in for a child
      // that never exits — the case the resolve deadline exists to bound.
      if (result.hang !== true) {
        yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(result.exitCode));
      }

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
        // A killed child exits: settle the deferred so an interrupt can finish.
        // Without this the fake reproduces the very hang `forceKillAfter`
        // guards against in the real spawner.
        kill: () =>
          Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(137)).pipe(Effect.asVoid),
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

const IMAGE = "supabase/postgres:17";

class EnsureImageTestError extends Data.TaggedError("EnsureImageTestError")<{
  readonly cause: unknown;
}> {}

describe("resolveDeadline", () => {
  it.effect("defaults to the shared budget and accepts a caller-sized one", () =>
    Effect.sync(() => {
      const before = resolveDeadline(0);
      expect(resolveDeadline()).toBeGreaterThanOrEqual(before + RESOLVE_BUDGET_MS - 50);
      const after = resolveDeadline(0);
      expect(resolveDeadline(1_000)).toBeLessThanOrEqual(after + 1_000);
    }),
  );
});

describe("resolveImage", () => {
  it.live("returns the first candidate already present in the local cache", () => {
    // `image inspect` exits 0 -> cache hit, so no pull is ever attempted.
    const mock = mockSpawner(() => ({ exitCode: 0 }));
    return resolveImage(mock.spawner, IMAGE, resolveDeadline(5_000)).pipe(
      Effect.map((resolved) => {
        expect(resolved).toContain("supabase/postgres:17");
        expect(mock.spawned.some((args) => args[0] === "pull")).toBe(false);
      }),
    );
  });

  it.live("fails clearly when docker itself cannot be spawned", () => {
    // The production resolver would silently fall back to podman, but callers
    // run raw `docker` argv — so a podman-resolved image would be invisible.
    const spawner = ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "docker not found",
        }),
      ),
    );
    return resolveImage(spawner, IMAGE, resolveDeadline(5_000)).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error.message).toContain("docker is required");
        expect(error.message).not.toContain("SUPABASE_INTERNAL_IMAGE_REGISTRY");
      }),
    );
  });

  it.live("fails when the docker CLI is present but exits non-zero", () => {
    // Regression guard: `spawner.exitCode` SUCCEEDS with the code, so a probe
    // that only maps spawn errors would wave a broken docker through.
    const mock = mockSpawner((args) =>
      args[0] === "--version" ? { exitCode: 1 } : { exitCode: 0 },
    );
    return resolveImage(mock.spawner, IMAGE, resolveDeadline(5_000)).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error.message).toContain("exited non-zero");
        expect(error.message).not.toContain("SUPABASE_INTERNAL_IMAGE_REGISTRY");
        expect(mock.spawned.some((args) => args[0] === "image")).toBe(false);
      }),
    );
  });

  it.live("keeps the resolver's own detail when it fails for a non-timeout reason", () => {
    // Uses the daemon-unreachable path because it fails fast: the resolver's
    // multi-candidate retry ladder really sleeps 4s+8s per candidate, and its
    // aggregated "all registries" message is already covered by that module's
    // own TestClock-driven test. What matters here is only that the wrapper
    // forwards the resolver's message instead of flattening it.
    const mock = mockSpawner((args) =>
      args[0] === "--version"
        ? { exitCode: 0 }
        : {
            exitCode: 1,
            stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.",
          },
    );
    return resolveImage(mock.spawner, IMAGE, resolveDeadline(5_000)).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error.message).toContain(`failed to resolve ${IMAGE}`);
        expect(error.message).toContain("Cannot connect to the Docker daemon");
        // The registry-pin hint must NOT appear here: no registry pin can fix
        // an unreachable daemon, and suggesting one misdirects CI triage.
        expect(error.message).not.toContain("SUPABASE_INTERNAL_IMAGE_REGISTRY");
        expect(mock.spawned.some((args) => args[0] === "pull")).toBe(false);
      }),
    );
  });

  it.live("moves to the next registry when a pull attempt outlives its share", () => {
    // The point of handing the deadline INTO the resolver: one wedged
    // candidate must not consume the budget the fallbacks behind it need.
    const pulled: Array<string> = [];
    const mock = mockSpawner((args) => {
      if (args[0] === "--version") return { exitCode: 0 };
      if (args[0] === "image") return { exitCode: 1, stderr: "no such image" };
      pulled.push(args[1] ?? "");
      // The first candidate's pull never exits; the rest fail fast.
      return pulled.length === 1 ? { exitCode: 0, hang: true } : { exitCode: 1, stderr: "denied" };
    });
    return resolveImage(mock.spawner, IMAGE, resolveDeadline(600)).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(new Set(pulled).size).toBeGreaterThan(1);
        expect(error.message).toContain("timed out after");
        expect(error.message).toContain("denied");
      }),
    );
  });

  it.live("reports an exhausted share against the candidate that spent it", () => {
    return Effect.gen(function* () {
      const mock = mockSpawner((args) => {
        if (args[0] === "--version") return { exitCode: 0 };
        return { exitCode: 1, stderr: "no such image" };
      });
      const now = resolveDeadline(0);
      yield* resolveImage(mock.spawner, IMAGE, now - 10_000).pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error.message).toContain("candidate budget exhausted");
          expect(error.message).toContain("SUPABASE_INTERNAL_IMAGE_REGISTRY");
        }),
      );
    });
  });

  it.live("falls back to the backstop message when the daemon itself hangs", () => {
    // `docker image inspect` is not deadline-bounded inside the resolver, so a
    // wedged daemon is caught by the helper's outer backstop instead.
    const mock = mockSpawner((args) => {
      if (args[0] === "--version") return { exitCode: 0 };
      return { exitCode: 0, hang: true };
    });
    return resolveImage(mock.spawner, IMAGE, resolveDeadline(200)).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error.message).toContain(`timed out resolving ${IMAGE}`);
        expect(error.message).toContain("daemon");
      }),
    );
  });
});

describe("ensureImage", () => {
  const layerFor = (mock: ReturnType<typeof mockSpawner>) =>
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, mock.spawner);

  const ensureImageEffect = (
    image: string,
    deadline: number,
    layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
  ) =>
    Effect.tryPromise({
      try: () => ensureImage(image, deadline, layer),
      catch: (cause) => new EnsureImageTestError({ cause }),
    });

  it.effect("memoizes per image, including across differing deadlines", () =>
    Effect.gen(function* () {
      const mock = mockSpawner(() => ({ exitCode: 0 }));
      const now = resolveDeadline(0);
      const image = `memo-${now}-a`;
      const first = yield* ensureImageEffect(image, now + 5_000, layerFor(mock));
      const spawnsAfterFirst = mock.spawned.length;
      const second = yield* ensureImageEffect(image, now + 60_000, layerFor(mock));
      expect(second).toBe(first);
      expect(mock.spawned.length).toBe(spawnsAfterFirst);
    }),
  );

  it.effect("memoizes failures so the retry ladder is never re-paid", () =>
    Effect.gen(function* () {
      const mock = mockSpawner((args) =>
        args[0] === "--version" ? { exitCode: 0 } : { exitCode: 1, stderr: "no such image" },
      );
      const now = resolveDeadline(0);
      const image = `memo-${now}-fail`;
      const first = yield* ensureImageEffect(image, now - 1_000, layerFor(mock)).pipe(Effect.exit);
      expect(Exit.isFailure(first)).toBe(true);
      const spawnsAfterFirst = mock.spawned.length;
      const second = yield* ensureImageEffect(image, now - 1_000, layerFor(mock)).pipe(Effect.exit);
      expect(Exit.isFailure(second)).toBe(true);
      expect(mock.spawned.length).toBe(spawnsAfterFirst);
    }),
  );

  it.effect("serializes distinct images: the second never spawns before the first settles", () =>
    Effect.gen(function* () {
      const firstSpawnCounts: Array<number> = [];
      const mock = mockSpawner((args) => {
        if (args[0] === "--version") return { exitCode: 0 };
        return { exitCode: 1, stderr: "no such image" };
      });
      const now = resolveDeadline(0);
      const imageA = `queue-${now}-a`;
      const imageB = `queue-${now}-b`;
      // Enqueue both before awaiting either; the queue must fully settle A
      // (including its failure) before B's first spawn happens.
      const a = yield* Effect.forkChild(
        ensureImageEffect(imageA, now - 1_000, layerFor(mock)).pipe(
          Effect.catch(() => Effect.void),
        ),
      );
      const spawnsWhenBEnqueued = mock.spawned.length;
      const b = yield* Effect.forkChild(
        ensureImageEffect(imageB, now - 1_000, layerFor(mock)).pipe(
          Effect.catch(() => Effect.void),
        ),
      );
      expect(mock.spawned.length).toBe(spawnsWhenBEnqueued);
      yield* Fiber.join(a);
      firstSpawnCounts.push(mock.spawned.length);
      yield* Fiber.join(b);
      expect(firstSpawnCounts[0]).toBeLessThanOrEqual(mock.spawned.length);
    }),
  );
});
