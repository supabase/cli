import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Option, Path } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import { CommandPlatformApiFactory } from "../auth/command-platform-api-factory.service.ts";
import { start } from "../commands/start/start.handler.ts";
import type { StartFlags } from "../commands/start/start.command.ts";
import { stop } from "../commands/stop/stop.handler.ts";
import type { StopFlags } from "../commands/stop/stop.command.ts";
import { Output } from "../shared/output/output.service.ts";
import { CliArgs } from "../shared/cli/cli-args.service.ts";
import {
  mockCommandSettings,
  mockTelemetryStateTracked,
  sequentialExecBatch,
} from "../../tests/helpers/command-mocks.ts";
import { dockerModel, type DockerModel } from "../../tests/helpers/docker-model.ts";
import {
  mockAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../tests/helpers/mocks.ts";
import { unusedStackServices } from "../../tests/helpers/unused-stack.ts";
import { DbConnection, type DbSession } from "./db-connection.service.ts";
import { dockerRunLayer } from "./docker-run.layer.ts";
import { DebugFlag, ExperimentalFlag, NetworkIdFlag, YesFlag } from "./global-flags.ts";
import {
  ProjectLifecycleLockBusyError,
  ProjectLifecycleLockIoError,
} from "./project-lifecycle-lock.ts";

const startFlags: StartFlags = { exclude: [], ignoreHealthCheck: false, preview: false };

const stopFlags = (overrides: Partial<StopFlags> = {}): StopFlags => ({
  projectId: Option.none(),
  backup: true,
  noBackup: false,
  all: Option.none(),
  ...overrides,
});

const alwaysReadyHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }))),
  ),
);

/** The restart path of `start` opens a database session to converge webhooks; an empty one suffices. */
const emptyDbSession: DbSession = {
  exec: () => Effect.void,
  query: () => Effect.succeed([]),
  execBatch: (statements) => sequentialExecBatch(emptyDbSession)(statements),
  extensionExists: () => Effect.succeed(false),
  copyToCsv: () => Effect.succeed(new Uint8Array()),
  queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
};

/**
 * Suspends whoever calls `hold` until the test calls `Deferred.succeed(release)`. The test scope
 * releases it on exit so a failed assertion cannot leave a paused rollback, which runs
 * uninterruptibly, blocking cleanup.
 */
const pause = Effect.fnUntraced(function* () {
  const reached = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
  return {
    reached,
    release,
    hold: Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release))),
  };
});

/**
 * One CLI process: its own working directory for `project_id`, its own output, and a `waiting`
 * signal that completes when the process prints the lifecycle lock's waiting line. Every process
 * shares the Docker daemon and `supabaseHome`, like two terminals on one machine.
 */
const makeProcess = Effect.fnUntraced(function* (
  docker: DockerModel,
  supabaseHome: string,
  projectId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-lifecycle-lock-" });
  yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
  yield* fs.writeFileString(
    path.join(workdir, "supabase", "config.toml"),
    `project_id = "${projectId}"\n`,
  );

  const out = mockOutput({ format: "text" });
  const waiting = yield* Deferred.make<void>();
  const output = Layer.effect(
    Output,
    Effect.gen(function* () {
      const base = yield* Output;
      return {
        ...base,
        raw: (text: string, stream?: "stdout" | "stderr") =>
          base
            .raw(text, stream)
            .pipe(
              Effect.tap(() =>
                text.startsWith("Waiting for another Supabase CLI command")
                  ? Deferred.succeed(waiting, undefined)
                  : Effect.void,
              ),
            ),
      };
    }),
  ).pipe(Layer.provide(out.layer));

  const layer = Layer.mergeAll(
    unusedStackServices,
    BunServices.layer,
    output,
    mockCommandSettings({ workdir, supabaseHome, projectId: Option.none() }),
    mockTelemetryStateTracked().layer,
    mockAnalytics().layer,
    docker.layer,
    alwaysReadyHttpClientLayer,
    Layer.succeed(DbConnection, { connect: () => Effect.succeed(emptyDbSession) }),
    dockerRunLayer.pipe(Layer.provide(docker.layer), Layer.provide(mockProcessControl().layer)),
    mockProcessControl().layer,
    mockRuntimeInfo({ platform: "linux" }),
    Layer.succeed(CommandPlatformApiFactory, {
      make: Effect.die("CommandPlatformApiFactory should not be used by a local start"),
    }),
    Layer.succeed(CliArgs, { args: [] }),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(YesFlag, false),
    Layer.succeed(ExperimentalFlag, false),
    Layer.succeed(NetworkIdFlag, Option.none()),
    mockTty({ stdinIsTty: false }),
    mockStdin(false),
  );
  return { out, waiting, layer };
});

type CliProcess = Effect.Success<ReturnType<typeof makeProcess>>;

const runStart = (cli: CliProcess) =>
  start(startFlags).pipe(Effect.provide(cli.layer), Effect.forkChild({ startImmediately: true }));

const runStop = (cli: CliProcess, flags: StopFlags = stopFlags()) =>
  stop(flags).pipe(Effect.provide(cli.layer), Effect.forkChild({ startImmediately: true }));

/** Resolves as soon as the process either prints the waiting line or finishes. */
const waitingOrFinished = (cli: CliProcess, fiber: Fiber.Fiber<unknown, unknown>) =>
  Effect.raceFirst(
    Deferred.await(cli.waiting).pipe(Effect.as("waiting" as const)),
    Fiber.await(fiber).pipe(Effect.as("finished" as const)),
  );

const isNetworkCreate = (args: ReadonlyArray<string>) =>
  args[0] === "network" && args[1] === "create";
const isNetworkPrune = (args: ReadonlyArray<string>) =>
  args[0] === "network" && args[1] === "prune";

const NETWORK = "supabase_network_demo";

describe("project lifecycle lock", () => {
  it.live(
    "holds a stop of the same project until the start in flight has attached its containers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-lifecycle-home-" });
        const networkCreated = yield* pause();
        const docker = dockerModel({
          after: (args) => (isNetworkCreate(args) ? networkCreated.hold : Effect.void),
        });
        const starter = yield* makeProcess(docker, home, "demo");
        const stopper = yield* makeProcess(docker, home, "demo");

        const starting = yield* runStart(starter);
        yield* Deferred.await(networkCreated.reached);
        const stopping = yield* runStop(stopper);

        expect(yield* waitingOrFinished(stopper, stopping)).toBe("waiting");
        expect(stopper.out.stderrText).toContain(
          "Waiting for another Supabase CLI command to finish with project demo...",
        );
        expect(docker.networkNames()).toEqual([NETWORK]);

        yield* Deferred.succeed(networkCreated.release, undefined);
        yield* Fiber.join(starting);
        yield* Fiber.join(stopping);
        expect(docker.containerNames()).toEqual([]);
        expect(docker.networkNames()).toEqual([]);
      }).pipe(Effect.provide(BunServices.layer)),
    10_000,
  );

  it.live(
    "holds stop --all until the start in flight has attached its containers",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-lifecycle-home-" });
        const networkCreated = yield* pause();
        const docker = dockerModel({
          after: (args) => (isNetworkCreate(args) ? networkCreated.hold : Effect.void),
        });
        const starter = yield* makeProcess(docker, home, "demo");
        const stopper = yield* makeProcess(docker, home, "other");

        const starting = yield* runStart(starter);
        yield* Deferred.await(networkCreated.reached);
        const stopping = yield* runStop(stopper, stopFlags({ all: Option.some(true) }));

        expect(yield* waitingOrFinished(stopper, stopping)).toBe("waiting");
        expect(stopper.out.stderrText).toContain(
          "Waiting for another Supabase CLI command to finish with local Supabase projects...",
        );
        expect(docker.networkNames()).toEqual([NETWORK]);

        yield* Deferred.succeed(networkCreated.release, undefined);
        yield* Fiber.join(starting);
        yield* Fiber.join(stopping);
        expect(docker.containerNames()).toEqual([]);
        expect(docker.networkNames()).toEqual([]);
      }).pipe(Effect.provide(BunServices.layer)),
    10_000,
  );

  it.live(
    "holds a start until stop --all has finished pruning",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-lifecycle-home-" });
        const pruning = yield* pause();
        const docker = dockerModel({
          before: Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
            if (isNetworkPrune(args)) yield* pruning.hold;
            return undefined;
          }),
        });
        const stopper = yield* makeProcess(docker, home, "other");
        const starter = yield* makeProcess(docker, home, "demo");

        const stopping = yield* runStop(stopper, stopFlags({ all: Option.some(true) }));
        yield* Deferred.await(pruning.reached);
        const starting = yield* runStart(starter);

        expect(yield* waitingOrFinished(starter, starting)).toBe("waiting");
        expect(starter.out.stderrText).toContain(
          "Waiting for another Supabase CLI command to finish with local Supabase projects...",
        );
        expect(docker.networkNames()).toEqual([]);

        yield* Deferred.succeed(pruning.release, undefined);
        yield* Fiber.join(stopping);
        yield* Fiber.join(starting);
        expect(docker.networkNames()).toEqual([NETWORK]);
      }).pipe(Effect.provide(BunServices.layer)),
    10_000,
  );

  it.live(
    "lets starts of different projects run side by side",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-lifecycle-home-" });
        const alphaNetworkCreated = yield* pause();
        const docker = dockerModel({
          after: (args) =>
            isNetworkCreate(args) && args.at(-1) === "supabase_network_alpha"
              ? alphaNetworkCreated.hold
              : Effect.void,
        });
        const alpha = yield* makeProcess(docker, home, "alpha");
        const beta = yield* makeProcess(docker, home, "beta");

        const startingAlpha = yield* runStart(alpha);
        yield* Deferred.await(alphaNetworkCreated.reached);
        const startingBeta = yield* runStart(beta);

        expect(yield* waitingOrFinished(beta, startingBeta)).toBe("finished");
        expect(docker.containerNames()).toContain("supabase_db_beta");
        expect(docker.containerNames()).not.toContain("supabase_db_alpha");

        yield* Deferred.succeed(alphaNetworkCreated.release, undefined);
        yield* Fiber.join(startingAlpha);
        yield* Fiber.join(startingBeta);
        expect(docker.containerNames()).toContain("supabase_db_alpha");
        expect(docker.networkNames()).toEqual(["supabase_network_alpha", "supabase_network_beta"]);
      }).pipe(Effect.provide(BunServices.layer)),
    10_000,
  );

  it.live(
    "holds a second start until the first start has finished rolling back",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-lifecycle-home-" });
        const rollbackAtNetworkPrune = yield* pause();
        let firstStartFailed = false;
        let rollbackPaused = false;
        const docker = dockerModel({
          before: Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
            if (args[0] === "create" && args.includes("supabase_auth_demo") && !firstStartFailed) {
              firstStartFailed = true;
              return { exitCode: 1, stderr: ["Error: no space left on device"] };
            }
            if (isNetworkPrune(args) && !rollbackPaused) {
              rollbackPaused = true;
              yield* rollbackAtNetworkPrune.hold;
            }
            return undefined;
          }),
        });
        const first = yield* makeProcess(docker, home, "demo");
        const second = yield* makeProcess(docker, home, "demo");

        const firstStarting = yield* runStart(first);
        yield* Deferred.await(rollbackAtNetworkPrune.reached);
        const secondStarting = yield* runStart(second);

        expect(yield* waitingOrFinished(second, secondStarting)).toBe("waiting");
        expect(docker.networkNames()).toEqual([NETWORK]);

        yield* Deferred.succeed(rollbackAtNetworkPrune.release, undefined);
        expect(Exit.isFailure(yield* Fiber.await(firstStarting))).toBe(true);
        yield* Fiber.join(secondStarting);
        expect(docker.networkNames()).toEqual([NETWORK]);
        expect(docker.containerNames()).toContain("supabase_auth_demo");
      }).pipe(Effect.provide(BunServices.layer)),
    10_000,
  );

  it.live(
    "leaves the start in flight untouched when a waiting stop is interrupted",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-lifecycle-home-" });
        const networkCreated = yield* pause();
        const docker = dockerModel({
          after: (args) => (isNetworkCreate(args) ? networkCreated.hold : Effect.void),
        });
        const starter = yield* makeProcess(docker, home, "demo");
        const stopper = yield* makeProcess(docker, home, "demo");

        const starting = yield* runStart(starter);
        yield* Deferred.await(networkCreated.reached);
        const stopping = yield* runStop(stopper);
        expect(yield* waitingOrFinished(stopper, stopping)).toBe("waiting");

        yield* Fiber.interrupt(stopping);
        expect(docker.networkNames()).toEqual([NETWORK]);

        yield* Deferred.succeed(networkCreated.release, undefined);
        yield* Fiber.join(starting);
        expect(docker.containerNames()).toContain("supabase_db_demo");
        expect(docker.networkNames()).toEqual([NETWORK]);

        yield* Fiber.join(yield* runStop(stopper));
        expect(docker.containerNames()).toEqual([]);
        expect(docker.networkNames()).toEqual([]);
      }).pipe(Effect.provide(BunServices.layer)),
    10_000,
  );

  it.effect("fails a start that outwaits the lock budget without touching the owner's stack", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-lifecycle-home-" });
      const networkCreated = yield* pause();
      const docker = dockerModel({
        after: (args) => (isNetworkCreate(args) ? networkCreated.hold : Effect.void),
      });
      const owner = yield* makeProcess(docker, home, "demo");
      const waiter = yield* makeProcess(docker, home, "demo");

      yield* runStart(owner);
      yield* Deferred.await(networkCreated.reached);
      const blocked = yield* start(startFlags).pipe(
        Effect.provide(waiter.layer),
        Effect.flip,
        Effect.forkChild({ startImmediately: true }),
      );
      // The lock polls on the controlled clock, so step it until the waiter has polled once.
      yield* Effect.raceFirst(
        Effect.forever(TestClock.adjust("1 second")),
        waitingOrFinished(waiter, blocked),
      );
      expect(yield* waitingOrFinished(waiter, blocked)).toBe("waiting");
      yield* TestClock.adjust("10 minutes");

      expect(yield* Fiber.join(blocked)).toBeInstanceOf(ProjectLifecycleLockBusyError);
      expect(docker.networkNames()).toEqual([NETWORK]);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("fails before any Docker command when the lock directory cannot be created", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-lifecycle-home-" });
      const notADirectory = path.join(base, "file");
      yield* fs.writeFileString(notADirectory, "");
      const docker = dockerModel();
      const cli = yield* makeProcess(docker, path.join(notADirectory, "home"), "demo");

      const error = yield* start(startFlags).pipe(Effect.provide(cli.layer), Effect.flip);

      expect(error).toBeInstanceOf(ProjectLifecycleLockIoError);
      expect(docker.commands()).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  );
});
