import { describe, expect, test } from "vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { mockBinaryResolver } from "../tests/helpers/mocks.ts";
import { BinaryResolver } from "./BinaryResolver.ts";
import { prefetch } from "./prefetch.ts";
import {
  ServiceDownloadFinished,
  ServiceDownloadStarted,
  StackPreparation,
  type StackPreparationEvent,
} from "./StackPreparation.ts";
import { prepareAssetsWithDependencies } from "./StackPreparation.ts";
import { DEFAULT_VERSIONS } from "./versions.ts";

const encoder = new TextEncoder();

interface SpawnResult {
  readonly exitCode: number;
  readonly stderr?: ReadonlyArray<string>;
}

function mockSequenceSpawner(results: ReadonlyArray<SpawnResult>) {
  const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  let index = 0;

  return {
    layer: Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const cmd = command._tag === "StandardCommand" ? command.command : "";
          const args = command._tag === "StandardCommand" ? command.args : [];
          spawned.push({ command: cmd, args });

          const result = results[index] ?? { exitCode: 0 };
          index += 1;

          const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          yield* Effect.forkDetach(
            Effect.andThen(
              Effect.sleep("1 millis"),
              Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(result.exitCode)),
            ),
          );

          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(2000 + index),
            stdout: Stream.empty,
            stderr: Stream.fromIterable(
              (result.stderr ?? []).map((line) => encoder.encode(`${line}\n`)),
            ),
            all: Stream.empty,
            exitCode: Deferred.await(exitDeferred),
            isRunning: Effect.succeed(true),
            stdin: Sink.drain,
            kill: () => Effect.void,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      ),
    ),
    get spawned() {
      return spawned;
    },
  };
}

describe("prefetch", () => {
  test("falls back to Docker Hub after ECR rate limiting", async () => {
    const resolver = mockBinaryResolver({ failServices: ["auth"] });
    const spawner = mockSequenceSpawner([
      { exitCode: 1 },
      { exitCode: 1 },
      { exitCode: 1 },
      { exitCode: 1, stderr: ["toomanyrequests: Rate exceeded"] },
      { exitCode: 1, stderr: ["toomanyrequests: Rate exceeded"] },
      { exitCode: 0 },
    ]);

    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const result = await Effect.runPromise(
      prefetch({
        mode: "docker",
        services: ["auth"],
      }).pipe(Effect.provide(layer)),
    );

    expect(result.auth).toEqual({
      type: "docker",
      image: "supabase/gotrue:v2.188.0-rc.15",
    });
    expect(
      spawner.spawned.filter((record) => record.args[0] === "pull").map((record) => record.args[1]),
    ).toEqual([
      "public.ecr.aws/supabase/gotrue:v2.188.0-rc.15",
      "public.ecr.aws/supabase/gotrue:v2.188.0-rc.15",
      "supabase/gotrue:v2.188.0-rc.15",
    ]);
  });

  test("falls back to GHCR after ECR and Docker Hub fail", async () => {
    const resolver = mockBinaryResolver({ failServices: ["auth"] });
    const spawner = mockSequenceSpawner([
      { exitCode: 1 },
      { exitCode: 1 },
      { exitCode: 1 },
      { exitCode: 1, stderr: ["manifest unknown"] },
      { exitCode: 1, stderr: ["toomanyrequests: Rate exceeded"] },
      { exitCode: 1, stderr: ["toomanyrequests: Rate exceeded"] },
      { exitCode: 0 },
    ]);

    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const result = await Effect.runPromise(
      prefetch({
        mode: "docker",
        services: ["auth"],
      }).pipe(Effect.provide(layer)),
    );

    expect(result.auth).toEqual({
      type: "docker",
      image: "ghcr.io/supabase/gotrue:v2.188.0-rc.15",
    });
    expect(
      spawner.spawned.filter((record) => record.args[0] === "pull").map((record) => record.args[1]),
    ).toEqual([
      "public.ecr.aws/supabase/gotrue:v2.188.0-rc.15",
      "supabase/gotrue:v2.188.0-rc.15",
      "supabase/gotrue:v2.188.0-rc.15",
      "ghcr.io/supabase/gotrue:v2.188.0-rc.15",
    ]);
  });

  test("does not report downloading when the docker image is already cached locally", async () => {
    const resolver = mockBinaryResolver({ failServices: ["auth"] });
    const spawner = mockSequenceSpawner([{ exitCode: 0 }]);
    const events: string[] = [];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const resolverService = yield* BinaryResolver;
        const spawnerService = yield* ChildProcessSpawner.ChildProcessSpawner;
        const artifacts = yield* prepareAssetsWithDependencies(
          resolverService,
          spawnerService,
          {
            mode: "docker",
            services: ["auth"],
          },
          (event) =>
            Effect.sync(() => {
              if (
                event instanceof ServiceDownloadStarted ||
                event instanceof ServiceDownloadFinished
              ) {
                events.push(event._tag);
              }
            }),
        );
        return artifacts.resolutions;
      }).pipe(Effect.provide(resolver.layer), Effect.provide(spawner.layer)),
    );

    expect(result.auth).toEqual({
      type: "docker",
      image: "public.ecr.aws/supabase/gotrue:v2.188.0-rc.15",
    });
    expect(events).toEqual([]);
  });

  test("reports per-service download finished events as each service completes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Gate each download on a Deferred so we control completion order
        // deterministically, instead of relying on Effect.sleep races between
        // concurrent fibers.
        const postgresGate = yield* Deferred.make<void>();
        const authGate = yield* Deferred.make<void>();
        const postgrestGate = yield* Deferred.make<void>();

        const resolver = mockBinaryResolver({
          downloadedServices: ["postgres", "postgrest", "auth"],
          downloadGates: {
            postgres: Deferred.await(postgresGate),
            auth: Deferred.await(authGate),
            postgrest: Deferred.await(postgrestGate),
          },
        });

        const events = yield* Queue.unbounded<StackPreparationEvent>();

        const fiber = yield* Effect.forkChild(
          Effect.gen(function* () {
            const resolverService = yield* BinaryResolver;
            return yield* prepareAssetsWithDependencies(
              resolverService,
              {} as ChildProcessSpawner.ChildProcessSpawner["Service"],
              { mode: "native", services: ["postgres", "postgrest", "auth"] },
              (event) => Queue.offer(events, event),
            );
          }).pipe(Effect.provide(resolver.layer)),
        );

        const eventLabel = (e: StackPreparationEvent): string =>
          e._tag === "ServiceDownloadStarted" || e._tag === "ServiceDownloadFinished"
            ? `${e._tag}:${e.service}`
            : e._tag;
        const takeNext = Effect.map(Queue.take(events), eventLabel);

        // All three services must emit ServiceDownloadStarted before any can
        // finish, since every gate is still closed. The relative order between
        // the three starts is scheduler-dependent, so compare as a set.
        const startLabels = yield* Effect.all([takeNext, takeNext, takeNext]);
        expect(new Set(startLabels)).toEqual(
          new Set([
            "ServiceDownloadStarted:postgres",
            "ServiceDownloadStarted:auth",
            "ServiceDownloadStarted:postgrest",
          ]),
        );

        // Releasing each gate in turn must produce that service's finished
        // event before any other service can finish — proving events are
        // emitted incrementally per completion, not batched at the end.
        yield* Deferred.succeed(postgresGate, undefined);
        expect(yield* takeNext).toBe("ServiceDownloadFinished:postgres");

        yield* Deferred.succeed(authGate, undefined);
        expect(yield* takeNext).toBe("ServiceDownloadFinished:auth");

        yield* Deferred.succeed(postgrestGate, undefined);
        expect(yield* takeNext).toBe("ServiceDownloadFinished:postgrest");

        expect(yield* takeNext).toBe("PreparationCompleted");

        const artifacts = yield* Fiber.join(fiber);
        expect(Object.keys(artifacts.resolutions)).toEqual(["postgres", "postgrest", "auth"]);
      }),
    );
  });

  test("uses docker for edge-runtime in auto mode even when a native binary exists", async () => {
    const resolver = mockBinaryResolver();
    const spawner = mockSequenceSpawner([{ exitCode: 0 }]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const resolverService = yield* BinaryResolver;
        const spawnerService = yield* ChildProcessSpawner.ChildProcessSpawner;
        const artifacts = yield* prepareAssetsWithDependencies(resolverService, spawnerService, {
          mode: "auto",
          services: ["edge-runtime"],
        });
        return artifacts.resolutions;
      }).pipe(Effect.provide(resolver.layer), Effect.provide(spawner.layer)),
    );

    expect(result["edge-runtime"]).toEqual({
      type: "docker",
      image: `public.ecr.aws/supabase/edge-runtime:v${DEFAULT_VERSIONS["edge-runtime"]}`,
    });
    expect(resolver.resolved).toEqual([]);
  });
});
