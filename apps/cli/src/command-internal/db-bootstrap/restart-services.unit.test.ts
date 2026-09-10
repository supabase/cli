import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { mockOutput } from "../../../tests/helpers/mocks.ts";
import {
  ContainerRestartError,
  KongReloadError,
  restartContainer,
  restartServicesAndReloadKong,
  RestartServicesError,
  withSatelliteServicesStopped,
} from "./restart-services.ts";

/** Matches the standing `mockSpawner` shape used across `docker-*.unit.test.ts` files. */
function mockSpawner(
  handler: (args: ReadonlyArray<string>) => { exitCode: number; stdout?: string; stderr?: string },
) {
  const spawned: Array<ReadonlyArray<string>> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args : [];
      spawned.push(args);
      const result = handler(args);

      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(result.exitCode));

      const encoder = new TextEncoder();
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

const HEALTHY_STATE = '{"Running":true,"Status":"running","Health":{"Status":"healthy"}}';
const STOPPED_STATE = '{"Running":false,"Status":"exited"}';

describe("restartContainer", () => {
  it.live("spawns `docker restart <id>` and succeeds on exit 0", () => {
    const mock = mockSpawner(() => ({ exitCode: 0 }));
    return restartContainer(mock.spawner, "supabase_db_proj").pipe(
      Effect.map(() => {
        expect(mock.spawned).toEqual([["restart", "supabase_db_proj"]]);
      }),
    );
  });

  it.live('fails on a "not found" restart — NOT tolerant, unlike the satellite restarts', () => {
    const mock = mockSpawner(() => ({
      exitCode: 1,
      stderr: "Error: No such container: supabase_db_proj\n",
    }));
    return restartContainer(mock.spawner, "supabase_db_proj").pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(ContainerRestartError);
        expect(error.message).toContain("failed to restart container");
      }),
    );
  });
});

describe("restartServicesAndReloadKong", () => {
  const PROJECT_ID = "proj";
  const KONG_ID = "supabase_kong_proj";

  it.live("restarts the four satellite services then reloads Kong", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "container" && args[1] === "inspect")
        return { exitCode: 0, stdout: HEALTHY_STATE };
      return { exitCode: 0 };
    });
    return restartServicesAndReloadKong(mock.spawner, PROJECT_ID).pipe(
      Effect.map(() => {
        const restarted = mock.spawned.filter((args) => args[0] === "restart").map((a) => a[1]);
        expect(restarted).toEqual(
          expect.arrayContaining([
            "supabase_storage_proj",
            "supabase_auth_proj",
            "supabase_realtime_proj",
            "supabase_pooler_proj",
          ]),
        );
        expect(mock.spawned).toContainEqual([
          "exec",
          KONG_ID,
          "kong",
          "reload",
          "--nginx-conf",
          "/home/kong/custom_nginx.template",
        ]);
      }),
    );
  });

  it.live("restarts the four satellite services CONCURRENTLY, not sequentially", () =>
    Effect.gen(function* () {
      const barrier = yield* Deferred.make<void>();
      let inFlight = 0;
      const restarted: Array<string> = [];

      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const args = command._tag === "StandardCommand" ? command.args : [];
          if (args[0] === "restart") {
            restarted.push(args[1] ?? "");
            inFlight++;
            if (inFlight === 4) yield* Deferred.succeed(barrier, undefined);
            // Every one of the four restarts blocks here until ALL FOUR are in flight
            // simultaneously (Go's `utils.WaitAll`, a goroutine per service — reset.go:259-271).
            // If `restartSatelliteServices` ever regressed to a sequential restart (e.g.
            // `concurrency: 1`), the second restart would never even be DISPATCHED until the
            // first resolves, so `inFlight` would never reach 4 and this `await` would hang
            // forever, timing out the test instead of silently passing.
            yield* Deferred.await(barrier);
          } else if (args[0] === "container" && args[1] === "inspect" && args[2] === KONG_ID) {
            // Kong excluded from the stack — skips the reload, keeping this test focused on
            // the satellite-restart concurrency guarantee alone.
            const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
            yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(1));
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              stdout: Stream.empty,
              stderr: Stream.fromIterable([
                new TextEncoder().encode(`Error: No such container: ${KONG_ID}\n`),
              ]),
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

      yield* restartServicesAndReloadKong(spawner, PROJECT_ID);

      expect(restarted).toEqual(
        expect.arrayContaining([
          "supabase_storage_proj",
          "supabase_auth_proj",
          "supabase_realtime_proj",
          "supabase_pooler_proj",
        ]),
      );
    }),
  );

  it.live('tolerates a "not found" satellite restart without failing', () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "restart" && args[1] === "supabase_realtime_proj") {
        return { exitCode: 1, stderr: "Error: No such container: supabase_realtime_proj\n" };
      }
      if (args[0] === "container" && args[1] === "inspect")
        return { exitCode: 0, stdout: HEALTHY_STATE };
      return { exitCode: 0 };
    });
    return restartServicesAndReloadKong(mock.spawner, PROJECT_ID).pipe(Effect.asVoid);
  });

  it.live("joins multiple satellite-restart failures and never attempts the Kong reload", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "restart" && args[1] === "supabase_storage_proj") {
        return { exitCode: 1, stderr: "boom-storage" };
      }
      if (args[0] === "restart" && args[1] === "supabase_auth_proj") {
        return { exitCode: 1, stderr: "boom-auth" };
      }
      return { exitCode: 0 };
    });
    return restartServicesAndReloadKong(mock.spawner, PROJECT_ID).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error.message).toContain("failed to restart supabase_storage_proj");
        expect(error.message).toContain("failed to restart supabase_auth_proj");
        expect(mock.spawned.some((args) => args[0] === "exec")).toBe(false);
      }),
    );
  });

  it.live("skips the reload without failing when Kong is excluded from the stack", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "container" && args[1] === "inspect" && args[2] === KONG_ID) {
        return { exitCode: 1, stderr: `Error: No such container: ${KONG_ID}\n` };
      }
      return { exitCode: 0 };
    });
    return restartServicesAndReloadKong(mock.spawner, PROJECT_ID).pipe(
      Effect.map(() => {
        expect(mock.spawned.some((args) => args[0] === "exec")).toBe(false);
      }),
    );
  });

  it.live("skips the reload without failing when Kong is present but stopped", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "container" && args[1] === "inspect" && args[2] === KONG_ID) {
        return { exitCode: 0, stdout: STOPPED_STATE };
      }
      return { exitCode: 0 };
    });
    return restartServicesAndReloadKong(mock.spawner, PROJECT_ID).pipe(
      Effect.map(() => {
        expect(mock.spawned.some((args) => args[0] === "exec")).toBe(false);
      }),
    );
  });

  it.live("fails with the exact suggestion when the Kong inspect fails for another reason", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "container" && args[1] === "inspect" && args[2] === KONG_ID) {
        return { exitCode: 1, stderr: "Cannot connect to the Docker daemon\n" };
      }
      return { exitCode: 0 };
    });
    return restartServicesAndReloadKong(mock.spawner, PROJECT_ID).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(KongReloadError);
        if (!(error instanceof KongReloadError)) return;
        expect(error.message).toContain("failed to inspect kong");
        expect(error.suggestion).toContain(
          "Local services restarted, but API routes may return 502",
        );
        expect(error.suggestion).toContain(`docker restart ${KONG_ID}`);
        expect(error.suggestion).toContain(`docker logs ${KONG_ID}`);
      }),
    );
  });

  it.live("fails with the combined output and suggestion when `kong reload` itself fails", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "container" && args[1] === "inspect" && args[2] === KONG_ID) {
        return { exitCode: 0, stdout: HEALTHY_STATE };
      }
      if (args[0] === "exec" && args[1] === KONG_ID) {
        return { exitCode: 1, stderr: "nginx: [error] invalid config\n" };
      }
      return { exitCode: 0 };
    });
    return restartServicesAndReloadKong(mock.spawner, PROJECT_ID).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(KongReloadError);
        if (!(error instanceof KongReloadError)) return;
        // Byte-matches Go: `DockerExecOnceWithStream` sets a fixed `error executing command`
        // for a non-zero exec exit code (`utils/docker.go:646-648`) — not the exit code itself.
        expect(error.message).toContain("failed to reload kong: error executing command");
        expect(error.message).toContain("nginx: [error] invalid config");
        expect(error.suggestion).toContain(`docker restart ${KONG_ID}`);
        // Pins the `--nginx-conf` flag (reset.go:269, reset_test.go:512) — a bare
        // `kong reload` regenerates nginx.conf from Kong's default template and
        // drops the custom `email_templates` server, reintroducing #6059.
        expect(mock.spawned).toContainEqual([
          "exec",
          KONG_ID,
          "kong",
          "reload",
          "--nginx-conf",
          "/home/kong/custom_nginx.template",
        ]);
      }),
    );
  });
});

describe("withSatelliteServicesStopped", () => {
  const PROJECT_ID = "proj";

  it.live("stops every satellite before the work runs, and leaves them stopped on success", () => {
    const mock = mockSpawner(() => ({ exitCode: 0 }));
    let stoppedWhenWorkRan: ReadonlyArray<string> = [];
    return withSatelliteServicesStopped(
      mock.spawner,
      PROJECT_ID,
      Effect.sync(() => {
        stoppedWhenWorkRan = mock.spawned.filter((args) => args[0] === "stop").map((a) => a[1]!);
      }),
    ).pipe(
      Effect.provide(mockOutput().layer),
      Effect.map(() => {
        expect(stoppedWhenWorkRan).toEqual(
          expect.arrayContaining([
            "supabase_storage_proj",
            "supabase_auth_proj",
            "supabase_realtime_proj",
            "supabase_pooler_proj",
          ]),
        );
        expect(mock.spawned.filter((args) => args[0] === "start")).toEqual([]);
      }),
    );
  });

  it.live("restarts the satellites when the work fails, and reports the work's own error", () => {
    const mock = mockSpawner(() => ({ exitCode: 0 }));
    const boom = new Error("work failed");
    return withSatelliteServicesStopped(mock.spawner, PROJECT_ID, Effect.fail(boom)).pipe(
      Effect.provide(mockOutput().layer),
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBe(boom);
        expect(mock.spawned.filter((args) => args[0] === "start").map((a) => a[1])).toEqual(
          expect.arrayContaining([
            "supabase_storage_proj",
            "supabase_auth_proj",
            "supabase_realtime_proj",
            "supabase_pooler_proj",
          ]),
        );
      }),
    );
  });

  it.live("tolerates a satellite that has no container", () => {
    const mock = mockSpawner((args) =>
      args[1] === "supabase_realtime_proj"
        ? {
            exitCode: 1,
            stderr: "Error response from daemon: No such container: supabase_realtime_proj",
          }
        : { exitCode: 0 },
    );
    return withSatelliteServicesStopped(mock.spawner, PROJECT_ID, Effect.void).pipe(
      Effect.provide(mockOutput().layer),
    );
  });

  it.live("restarts the satellites when the reset is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const mock = mockSpawner(() => ({ exitCode: 0 }));
      const fiber = yield* Effect.forkChild(
        withSatelliteServicesStopped(
          mock.spawner,
          PROJECT_ID,
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }),
        ).pipe(Effect.provide(mockOutput().layer)),
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(mock.spawned.filter((args) => args[0] === "start").map((a) => a[1])).toEqual(
        expect.arrayContaining([
          "supabase_storage_proj",
          "supabase_auth_proj",
          "supabase_realtime_proj",
          "supabase_pooler_proj",
        ]),
      );
    }),
  );

  it.live("restarts the satellites that stopped when another stop fails", () => {
    const mock = mockSpawner((args) =>
      args[0] === "stop" && args[1] === "supabase_storage_proj"
        ? { exitCode: 1, stderr: "permission denied" }
        : { exitCode: 0 },
    );
    const out = mockOutput();
    return withSatelliteServicesStopped(mock.spawner, PROJECT_ID, Effect.void).pipe(
      Effect.provide(out.layer),
      Effect.flip,
      Effect.map(() => {
        expect(mock.spawned.filter((args) => args[0] === "start").map((a) => a[1])).toEqual(
          expect.arrayContaining([
            "supabase_auth_proj",
            "supabase_realtime_proj",
            "supabase_pooler_proj",
          ]),
        );
      }),
    );
  });

  it.live("fails without running the work when a stop genuinely fails", () => {
    const mock = mockSpawner((args) =>
      args[0] === "stop" && args[1] === "supabase_storage_proj"
        ? { exitCode: 1, stderr: "permission denied" }
        : { exitCode: 0 },
    );
    let ran = false;
    return withSatelliteServicesStopped(
      mock.spawner,
      PROJECT_ID,
      Effect.sync(() => {
        ran = true;
      }),
    ).pipe(
      Effect.provide(mockOutput().layer),
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(RestartServicesError);
        expect(ran).toBe(false);
      }),
    );
  });
});
