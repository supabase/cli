import { describe, expect, test } from "vitest";
import { Deferred, Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { mockBinaryResolver } from "../tests/helpers/mocks.ts";
import { BinaryResolver } from "./BinaryResolver.ts";
import { DockerPullError } from "./errors.ts";
import { prefetch } from "./prefetch.ts";
import {
  ServiceDownloadFinished,
  ServiceDownloadStarted,
  StackPreparation,
} from "./StackPreparation.ts";
import { prepareAssetsWithDependencies } from "./StackPreparation.ts";
import { DEFAULT_VERSIONS, SERVICE_NAMES } from "./versions.ts";

const encoder = new TextEncoder();
const defaultAuthEcrImage = `public.ecr.aws/supabase/gotrue:v${DEFAULT_VERSIONS.auth}`;
const defaultAuthDockerHubImage = `supabase/gotrue:v${DEFAULT_VERSIONS.auth}`;
const defaultAuthGhcrImage = `ghcr.io/supabase/gotrue:v${DEFAULT_VERSIONS.auth}`;

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
            unref: Effect.succeed(Effect.void),
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
  test("prefetches all services by default", async () => {
    const resolver = mockBinaryResolver();
    const spawner = mockSequenceSpawner(
      Array.from({ length: SERVICE_NAMES.length }, () => ({
        exitCode: 0,
      })),
    );

    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const result = await Effect.runPromise(prefetch().pipe(Effect.provide(layer)));

    expect(Object.keys(result).sort()).toEqual([...SERVICE_NAMES].sort());
  });

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
      image: defaultAuthDockerHubImage,
    });
    expect(
      spawner.spawned.filter((record) => record.args[0] === "pull").map((record) => record.args[1]),
    ).toEqual([defaultAuthEcrImage, defaultAuthEcrImage, defaultAuthDockerHubImage]);
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
      image: defaultAuthGhcrImage,
    });
    expect(
      spawner.spawned.filter((record) => record.args[0] === "pull").map((record) => record.args[1]),
    ).toEqual([
      defaultAuthEcrImage,
      defaultAuthDockerHubImage,
      defaultAuthDockerHubImage,
      defaultAuthGhcrImage,
    ]);
  });

  test("preparation fails with DockerPullError when all registry candidates fail", async () => {
    const resolver = mockBinaryResolver({ failServices: ["auth"] });
    // 3 image inspects (not cached locally) followed by a non-retryable pull for
    // each registry candidate (ECR, Docker Hub, GHCR). "manifest unknown" is not a
    // retryable pattern, so each candidate gets exactly one pull attempt: 3 + 3 = 6
    // spawns. With the whole fallback chain failing, preparation must fail rather
    // than defer the pull to startup.
    const spawner = mockSequenceSpawner([
      { exitCode: 1 },
      { exitCode: 1 },
      { exitCode: 1 },
      { exitCode: 1, stderr: ["manifest unknown"] },
      { exitCode: 1, stderr: ["manifest unknown"] },
      { exitCode: 1, stderr: ["manifest unknown"] },
    ]);

    const layer = StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(spawner.layer),
    );

    const error = await Effect.runPromise(
      prefetch({ mode: "docker", services: ["auth"] }).pipe(Effect.provide(layer), Effect.flip),
    );

    expect(error).toBeInstanceOf(DockerPullError);
    // Guard the spawn-count assumption above: if the retry/candidate logic changes
    // so more spawns occur, the mock would default the extras to success and mask
    // the failure. Assert the exact count so that regresses loudly instead.
    expect(spawner.spawned).toHaveLength(6);
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
      image: defaultAuthEcrImage,
    });
    expect(events).toEqual([]);
  });

  test("reports per-service download finished events as each service completes", async () => {
    const resolver = mockBinaryResolver({
      downloadedServices: ["postgres", "postgrest", "auth"],
      downloadDelaysMs: {
        postgres: 10,
        auth: 30,
        postgrest: 50,
      },
    });
    const events: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const resolverService = yield* BinaryResolver;
        const artifacts = yield* prepareAssetsWithDependencies(
          resolverService,
          {} as ChildProcessSpawner.ChildProcessSpawner["Service"],
          {
            mode: "native",
            services: ["postgres", "postgrest", "auth"],
          },
          (event) =>
            Effect.sync(() => {
              switch (event._tag) {
                case "ServiceDownloadStarted":
                case "ServiceDownloadFinished":
                  events.push(`${event._tag}:${event.service}`);
                  break;
                case "PreparationCompleted":
                  events.push("PreparationCompleted");
                  break;
              }
            }),
        );
        expect(Object.keys(artifacts.resolutions)).toEqual(["postgres", "postgrest", "auth"]);
      }).pipe(Effect.provide(resolver.layer)),
    );

    expect(events.slice(0, 3)).toEqual([
      "ServiceDownloadStarted:postgres",
      "ServiceDownloadStarted:postgrest",
      "ServiceDownloadStarted:auth",
    ]);
    expect(events.slice(3, 6).sort()).toEqual([
      "ServiceDownloadFinished:auth",
      "ServiceDownloadFinished:postgres",
      "ServiceDownloadFinished:postgrest",
    ]);
    expect(events.at(-1)).toBe("PreparationCompleted");
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
