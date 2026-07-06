import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  LegacyDockerLifecycleInspectError,
  LegacyDockerLifecycleListError,
  legacyInspectContainerState,
  legacyListContainersByLabel,
  legacyListVolumesByLabel,
} from "./legacy-docker-lifecycle.ts";

function mockSpawner(
  opts: {
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
  } = {},
) {
  const encoder = new TextEncoder();
  const spawned: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const cmd = command._tag === "StandardCommand" ? command.command : "";
      const args = command._tag === "StandardCommand" ? command.args : [];
      spawned.push({ command: cmd, args });

      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(opts.exitCode ?? 0));

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.fromIterable(opts.stdout !== undefined ? [encoder.encode(opts.stdout)] : []),
        stderr: Stream.fromIterable(opts.stderr !== undefined ? [encoder.encode(opts.stderr)] : []),
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

describe("legacyListContainersByLabel", () => {
  it.live("returns container ids for a successful listing", () => {
    const mock = mockSpawner({ stdout: "abc123\ndef456\n" });
    return legacyListContainersByLabel(mock.spawner, {
      projectIdFilter: "com.supabase.cli.project=my-app",
      all: false,
      format: "id",
    }).pipe(
      Effect.map((ids) => {
        expect(ids).toEqual(["abc123", "def456"]);
        expect(mock.spawned).toEqual([
          {
            command: "docker",
            args: [
              "ps",
              "--filter",
              "label=com.supabase.cli.project=my-app",
              "--format",
              "{{.ID}}",
            ],
          },
        ]);
      }),
    );
  });

  it.live("passes --all and requests names when configured", () => {
    const mock = mockSpawner({ stdout: "supabase_db_my-app\n" });
    return legacyListContainersByLabel(mock.spawner, {
      projectIdFilter: "com.supabase.cli.project",
      all: true,
      format: "names",
    }).pipe(
      Effect.map((names) => {
        expect(names).toEqual(["supabase_db_my-app"]);
        expect(mock.spawned).toEqual([
          {
            command: "docker",
            args: [
              "ps",
              "--filter",
              "label=com.supabase.cli.project",
              "--all",
              "--format",
              "{{.Names}}",
            ],
          },
        ]);
      }),
    );
  });

  it.live("returns an empty array when no containers match", () => {
    const mock = mockSpawner({ stdout: "" });
    return legacyListContainersByLabel(mock.spawner, {
      projectIdFilter: "com.supabase.cli.project",
      all: true,
      format: "id",
    }).pipe(
      Effect.map((ids) => {
        expect(ids).toEqual([]);
      }),
    );
  });

  it.live("filters out blank lines from the trimmed output", () => {
    const mock = mockSpawner({ stdout: "abc123\n\n  \ndef456\n" });
    return legacyListContainersByLabel(mock.spawner, {
      projectIdFilter: "com.supabase.cli.project",
      all: false,
      format: "id",
    }).pipe(
      Effect.map((ids) => {
        expect(ids).toEqual(["abc123", "def456"]);
      }),
    );
  });

  it.live("fails with LegacyDockerLifecycleListError on a non-zero exit", () => {
    const mock = mockSpawner({ exitCode: 1, stderr: "Cannot connect to the Docker daemon\n" });
    return legacyListContainersByLabel(mock.spawner, {
      projectIdFilter: "com.supabase.cli.project",
      all: false,
      format: "id",
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyDockerLifecycleListError);
        expect(error.message).toBe(
          "failed to list containers: Cannot connect to the Docker daemon",
        );
      }),
    );
  });

  it.live("fails with a generic message when stderr is empty", () => {
    const mock = mockSpawner({ exitCode: 1, stderr: "" });
    return legacyListContainersByLabel(mock.spawner, {
      projectIdFilter: "com.supabase.cli.project",
      all: false,
      format: "id",
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyDockerLifecycleListError);
        expect(error.message).toBe("failed to list containers");
      }),
    );
  });
});

describe("legacyInspectContainerState", () => {
  it.live("parses a running, healthy container's state", () => {
    const mock = mockSpawner({
      stdout: JSON.stringify({
        Status: "running",
        Running: true,
        Health: { Status: "healthy" },
      }),
    });
    return legacyInspectContainerState(mock.spawner, "supabase_db_my-app").pipe(
      Effect.map((state) => {
        expect(state).toEqual({ running: true, status: "running", health: "healthy" });
        expect(mock.spawned).toEqual([
          {
            command: "docker",
            args: ["container", "inspect", "supabase_db_my-app", "--format", "{{json .State}}"],
          },
        ]);
      }),
    );
  });

  it.live("parses a running container with no health check configured", () => {
    const mock = mockSpawner({ stdout: JSON.stringify({ Status: "running", Running: true }) });
    return legacyInspectContainerState(mock.spawner, "supabase_kong_my-app").pipe(
      Effect.map((state) => {
        expect(state).toEqual({ running: true, status: "running" });
      }),
    );
  });

  it.live("parses a stopped/exited container", () => {
    const mock = mockSpawner({ stdout: JSON.stringify({ Status: "exited", Running: false }) });
    return legacyInspectContainerState(mock.spawner, "supabase_kong_my-app").pipe(
      Effect.map((state) => {
        expect(state).toEqual({ running: false, status: "exited" });
      }),
    );
  });

  it.live(
    "treats a paused/restarting container as running, matching Go's boolean-based gate",
    () => {
      // Go's `assertContainerHealthy` (`status.go:150`) checks `resp.State.Running`,
      // not `resp.State.Status` — a paused or restarting container reports
      // `Running: true` alongside a non-"running" status string, and Go
      // continues past the not-running branch in that case.
      const mock = mockSpawner({ stdout: JSON.stringify({ Status: "paused", Running: true }) });
      return legacyInspectContainerState(mock.spawner, "supabase_db_my-app").pipe(
        Effect.map((state) => {
          expect(state).toEqual({ running: true, status: "paused" });
        }),
      );
    },
  );

  it.live(
    "fails with LegacyDockerLifecycleInspectError, preserving the real stderr, when the container does not exist",
    () => {
      // Go's `assertContainerHealthy` never special-cases "not found" — it
      // wraps whatever `ContainerInspect` returns (`status.go:148-149`), so a
      // missing container is just another non-zero exit here too.
      const mock = mockSpawner({
        exitCode: 1,
        stderr: "Error response from daemon: No such container: supabase_db_my-app\n",
      });
      return legacyInspectContainerState(mock.spawner, "supabase_db_my-app").pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error).toBeInstanceOf(LegacyDockerLifecycleInspectError);
          expect(error.message).toBe(
            "failed to inspect container health: Error response from daemon: No such container: supabase_db_my-app",
          );
        }),
      );
    },
  );

  it.live("fails with LegacyDockerLifecycleInspectError on any other inspect failure", () => {
    const mock = mockSpawner({ exitCode: 1, stderr: "Cannot connect to the Docker daemon\n" });
    return legacyInspectContainerState(mock.spawner, "supabase_db_my-app").pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyDockerLifecycleInspectError);
        expect(error.message).toBe(
          "failed to inspect container health: Cannot connect to the Docker daemon",
        );
      }),
    );
  });

  it.live(
    "fails with LegacyDockerLifecycleInspectError with a generic message when stderr is empty",
    () => {
      const mock = mockSpawner({ exitCode: 1, stderr: "" });
      return legacyInspectContainerState(mock.spawner, "supabase_db_my-app").pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error).toBeInstanceOf(LegacyDockerLifecycleInspectError);
          expect(error.message).toBe("failed to inspect container health");
        }),
      );
    },
  );

  it.live("treats empty inspect output as an unknown, not-running state", () => {
    const mock = mockSpawner({ stdout: "" });
    return legacyInspectContainerState(mock.spawner, "supabase_db_my-app").pipe(
      Effect.map((state) => {
        expect(state).toEqual({ running: false, status: "" });
      }),
    );
  });

  it.live("treats non-object inspect JSON as an unknown, not-running state", () => {
    const mock = mockSpawner({ stdout: "null" });
    return legacyInspectContainerState(mock.spawner, "supabase_db_my-app").pipe(
      Effect.map((state) => {
        expect(state).toEqual({ running: false, status: "" });
      }),
    );
  });
});

describe("legacyListVolumesByLabel", () => {
  it.live("returns volume names for a successful listing", () => {
    const mock = mockSpawner({ stdout: "supabase_db_my-app\n" });
    return legacyListVolumesByLabel(mock.spawner, "com.supabase.cli.project=my-app").pipe(
      Effect.map((names) => {
        expect(names).toEqual(["supabase_db_my-app"]);
        expect(mock.spawned).toEqual([
          {
            command: "docker",
            args: [
              "volume",
              "ls",
              "--filter",
              "label=com.supabase.cli.project=my-app",
              "--format",
              "{{.Name}}",
            ],
          },
        ]);
      }),
    );
  });

  it.live("returns an empty array when no volumes remain", () => {
    const mock = mockSpawner({ stdout: "" });
    return legacyListVolumesByLabel(mock.spawner, "com.supabase.cli.project").pipe(
      Effect.map((names) => {
        expect(names).toEqual([]);
      }),
    );
  });

  it.live("fails with LegacyDockerLifecycleListError on a non-zero exit", () => {
    const mock = mockSpawner({ exitCode: 1, stderr: "boom\n" });
    return legacyListVolumesByLabel(mock.spawner, "com.supabase.cli.project").pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyDockerLifecycleListError);
        expect(error.message).toBe("failed to list volumes: boom");
      }),
    );
  });

  it.live("fails with a generic message when stderr is empty", () => {
    const mock = mockSpawner({ exitCode: 1, stderr: "" });
    return legacyListVolumesByLabel(mock.spawner, "com.supabase.cli.project").pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyDockerLifecycleListError);
        expect(error.message).toBe("failed to list volumes");
      }),
    );
  });
});
