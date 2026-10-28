import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";

import {
  EXEC_FAILURE_OUTPUT,
  PROBE_TIMEOUT_OUTPUT,
  inspectedState,
} from "../../tests/helpers/docker-health.ts";
import { classifyCliErrorActionability } from "../shared/telemetry/error-actionability.ts";
import {
  DockerLifecycleInspectError,
  DockerLifecycleListError,
  formatNotReadyReason,
  healthCheckCannotExec,
  inspectContainerState,
  listContainerIdsAndNames,
  listContainersByLabel,
  listVolumesByLabel,
  type ContainerState,
} from "./docker-lifecycle.ts";

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

describe("listContainersByLabel", () => {
  it.live("returns container ids for a successful listing", () => {
    const mock = mockSpawner({ stdout: "abc123\ndef456\n" });
    return listContainersByLabel(mock.spawner, {
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
    return listContainersByLabel(mock.spawner, {
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
    return listContainersByLabel(mock.spawner, {
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
    return listContainersByLabel(mock.spawner, {
      projectIdFilter: "com.supabase.cli.project",
      all: false,
      format: "id",
    }).pipe(
      Effect.map((ids) => {
        expect(ids).toEqual(["abc123", "def456"]);
      }),
    );
  });

  it.live("fails with DockerLifecycleListError on a non-zero exit", () => {
    const mock = mockSpawner({ exitCode: 1, stderr: "Cannot connect to the Docker daemon\n" });
    return listContainersByLabel(mock.spawner, {
      projectIdFilter: "com.supabase.cli.project",
      all: false,
      format: "id",
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(DockerLifecycleListError);
        expect(error.message).toBe(
          "failed to list containers: Cannot connect to the Docker daemon",
        );
      }),
    );
  });

  it.live("fails with a generic message when stderr is empty", () => {
    const mock = mockSpawner({ exitCode: 1, stderr: "" });
    return listContainersByLabel(mock.spawner, {
      projectIdFilter: "com.supabase.cli.project",
      all: false,
      format: "id",
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(DockerLifecycleListError);
        expect(error.message).toBe("failed to list containers");
      }),
    );
  });
});

describe("listContainerIdsAndNames", () => {
  it.live("parses id, name, and the com.supabase.cli.workdir label from a single ps call", () => {
    const mock = mockSpawner({
      stdout:
        "abc123\tsupabase_kong_demo\t/home/user/demo\ndef456\tsupabase_db_demo\t/home/user/demo\n",
    });
    return listContainerIdsAndNames(mock.spawner, {
      projectIdFilter: "com.supabase.cli.project=demo",
      all: true,
    }).pipe(
      Effect.map((containers) => {
        expect(containers).toEqual([
          { id: "abc123", name: "supabase_kong_demo", workdir: "/home/user/demo" },
          { id: "def456", name: "supabase_db_demo", workdir: "/home/user/demo" },
        ]);
        expect(mock.spawned).toEqual([
          {
            command: "docker",
            args: [
              "ps",
              "--filter",
              "label=com.supabase.cli.project=demo",
              "--all",
              "--format",
              '{{.ID}}\t{{.Names}}\t{{.Label "com.supabase.cli.workdir"}}',
            ],
          },
        ]);
      }),
    );
  });

  it.live(
    "resolves an empty workdir for a container carrying no com.supabase.cli.workdir label",
    () => {
      const mock = mockSpawner({ stdout: "abc123\tsupabase_kong_demo\t\n" });
      return listContainerIdsAndNames(mock.spawner, {
        projectIdFilter: "com.supabase.cli.project=demo",
        all: true,
      }).pipe(
        Effect.map((containers) => {
          expect(containers).toEqual([{ id: "abc123", name: "supabase_kong_demo", workdir: "" }]);
        }),
      );
    },
  );
});

describe("inspectContainerState", () => {
  it.live("parses a running, healthy container's state", () => {
    const mock = mockSpawner({
      stdout: JSON.stringify({
        Status: "running",
        Running: true,
        ExitCode: 0,
        Health: { Status: "healthy" },
      }),
    });
    return inspectContainerState(mock.spawner, "supabase_db_my-app").pipe(
      Effect.map((state) => {
        expect(state).toEqual({
          running: true,
          status: "running",
          exitCode: 0,
          oomKilled: false,
          health: "healthy",
        });
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
    const mock = mockSpawner({
      stdout: JSON.stringify({ Status: "running", Running: true, ExitCode: 0 }),
    });
    return inspectContainerState(mock.spawner, "supabase_kong_my-app").pipe(
      Effect.map((state) => {
        expect(state).toEqual({ running: true, status: "running", exitCode: 0, oomKilled: false });
      }),
    );
  });

  it.live("reports a container killed for exceeding its memory limit", () => {
    const mock = mockSpawner({
      stdout: JSON.stringify({
        Status: "exited",
        Running: false,
        ExitCode: 137,
        OOMKilled: true,
      }),
    });
    return inspectContainerState(mock.spawner, "supabase_edge_runtime_my-app").pipe(
      Effect.map((state) => {
        expect(state).toEqual({
          running: false,
          status: "exited",
          exitCode: 137,
          oomKilled: true,
        });
      }),
    );
  });

  it.live("parses a stopped/exited container", () => {
    const mock = mockSpawner({
      stdout: JSON.stringify({ Status: "exited", Running: false, ExitCode: 1 }),
    });
    return inspectContainerState(mock.spawner, "supabase_kong_my-app").pipe(
      Effect.map((state) => {
        expect(state).toEqual({ running: false, status: "exited", exitCode: 1, oomKilled: false });
      }),
    );
  });

  it.live(
    "treats a paused/restarting container as running, matching Go's boolean-based gate",
    () => {
      const mock = mockSpawner({
        stdout: JSON.stringify({ Status: "paused", Running: true, ExitCode: 0 }),
      });
      return inspectContainerState(mock.spawner, "supabase_db_my-app").pipe(
        Effect.map((state) => {
          expect(state).toEqual({ running: true, status: "paused", exitCode: 0, oomKilled: false });
        }),
      );
    },
  );

  it.live(
    "fails with DockerLifecycleInspectError, preserving the real stderr, when the container does not exist",
    () => {
      const mock = mockSpawner({
        exitCode: 1,
        stderr: "Error response from daemon: No such container: supabase_db_my-app\n",
      });
      return inspectContainerState(mock.spawner, "supabase_db_my-app").pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error).toBeInstanceOf(DockerLifecycleInspectError);
          expect(error.message).toBe(
            "failed to inspect container health: Error response from daemon: No such container: supabase_db_my-app",
          );
          expect(error.daemonDown).toBeFalsy();
          expect(classifyCliErrorActionability(error).error_category).toBe("invalid_config");
        }),
      );
    },
  );

  it.live("fails with DockerLifecycleInspectError on any other inspect failure", () => {
    const mock = mockSpawner({ exitCode: 1, stderr: "Cannot connect to the Docker daemon\n" });
    return inspectContainerState(mock.spawner, "supabase_db_my-app").pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(DockerLifecycleInspectError);
        expect(error.message).toBe(
          "failed to inspect container health: Cannot connect to the Docker daemon",
        );
        expect(error.daemonDown).toBe(true);
        const result = classifyCliErrorActionability(error);
        expect(result.error_category).toBe("docker_not_running");
        expect(result.error_fingerprint).toBe("tag:DockerLifecycleInspectError:docker_not_running");
      }),
    );
  });

  it.live(
    "fails with DockerLifecycleInspectError with a generic message when stderr is empty",
    () => {
      const mock = mockSpawner({ exitCode: 1, stderr: "" });
      return inspectContainerState(mock.spawner, "supabase_db_my-app").pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error).toBeInstanceOf(DockerLifecycleInspectError);
          expect(error.message).toBe("failed to inspect container health");
        }),
      );
    },
  );

  it.live("treats empty inspect output as an unknown, not-running state", () => {
    const mock = mockSpawner({ stdout: "" });
    return inspectContainerState(mock.spawner, "supabase_db_my-app").pipe(
      Effect.map((state) => {
        expect(state).toEqual({ running: false, status: "", exitCode: 0, oomKilled: false });
      }),
    );
  });

  it.live("treats non-object inspect JSON as an unknown, not-running state", () => {
    const mock = mockSpawner({ stdout: "null" });
    return inspectContainerState(mock.spawner, "supabase_db_my-app").pipe(
      Effect.map((state) => {
        expect(state).toEqual({ running: false, status: "", exitCode: 0, oomKilled: false });
      }),
    );
  });
});

describe("inspectContainerState health probe", () => {
  const inspectLastProbe = (stdout: string) =>
    inspectContainerState(mockSpawner({ stdout }).spawner, "supabase_db_my-app");

  it.live("reads the exec-start failure Docker recorded for a probe it could not launch", () =>
    inspectLastProbe(
      inspectedState({
        health: "unhealthy",
        probes: [{ exitCode: -1, output: EXEC_FAILURE_OUTPUT }],
      }),
    ).pipe(
      Effect.map((state) => {
        expect(state.health).toBe("unhealthy");
        expect(state.lastHealthProbe).toEqual({ exitCode: -1, output: EXEC_FAILURE_OUTPUT });
        expect(healthCheckCannotExec(state)).toBe(true);
      }),
    ),
  );

  it.live("keeps only the most recent entry of Health.Log", () =>
    inspectLastProbe(
      inspectedState({
        health: "unhealthy",
        probes: [
          { exitCode: 1, output: "first" },
          { exitCode: 2, output: "second" },
          { exitCode: 3, output: "third" },
        ],
      }),
    ).pipe(
      Effect.map((state) => {
        expect(state.lastHealthProbe).toEqual({ exitCode: 3, output: "third" });
      }),
    ),
  );

  it.live("collapses whitespace runs and newlines in the probe output", () =>
    inspectLastProbe(
      inspectedState({
        health: "unhealthy",
        probes: [{ exitCode: 1, output: "  pg_isready:\n\tno   response\r\n  " }],
      }),
    ).pipe(
      Effect.map((state) => {
        expect(state.lastHealthProbe?.output).toBe("pg_isready: no response");
      }),
    ),
  );

  it.live("keeps probe output of exactly 300 characters whole", () => {
    const output = "x".repeat(300);
    return inspectLastProbe(
      inspectedState({ health: "unhealthy", probes: [{ exitCode: 1, output }] }),
    ).pipe(
      Effect.map((state) => {
        expect(state.lastHealthProbe?.output).toBe(output);
        expect(formatNotReadyReason(state)).toContain(`: ${output})`);
      }),
    );
  });

  it.live("keeps the full probe output and cuts only the rendered reason at 300 characters", () =>
    inspectLastProbe(
      inspectedState({
        health: "unhealthy",
        probes: [{ exitCode: 1, output: "x".repeat(301) }],
      }),
    ).pipe(
      Effect.map((state) => {
        expect(state.lastHealthProbe?.output).toBe("x".repeat(301));
        expect(formatNotReadyReason(state)).toContain(`: ${"x".repeat(299)}…)`);
      }),
    ),
  );

  const validProbe = { Start: "s", End: "e", ExitCode: 1, Output: "ok" };
  const malformedLogs: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["has no Log", { Status: "unhealthy" }],
    ["has a Log that is not an array", { Status: "unhealthy", Log: "oops" }],
    ["has an empty Log", { Status: "unhealthy", Log: [] }],
    ["ends in an entry that is not an object", { Status: "unhealthy", Log: [validProbe, null] }],
    ["ends in an entry with a string ExitCode", { Status: "unhealthy", Log: [{ ExitCode: "-1" }] }],
    [
      "ends in an entry with no Output",
      { Status: "unhealthy", Log: [validProbe, { ExitCode: -1 }] },
    ],
    [
      "ends in an entry with a non-string Output",
      { Status: "unhealthy", Log: [{ ExitCode: -1, Output: 7 }] },
    ],
  ];
  for (const [scenario, health] of malformedLogs) {
    it.live(`reports no probe when Health ${scenario}`, () =>
      inspectLastProbe(JSON.stringify({ Status: "running", Running: true, Health: health })).pipe(
        Effect.map((state) => {
          expect(state).toEqual({
            running: true,
            status: "running",
            exitCode: 0,
            oomKilled: false,
            health: "unhealthy",
          });
          expect(state).not.toHaveProperty("lastHealthProbe");
        }),
      ),
    );
  }
});

describe("healthCheckCannotExec", () => {
  const OLDER_RUNC_EXEC_FAILURE =
    "OCI runtime exec failed: exec failed: container_linux.go:380: starting container process caused: process_linux.go:103: executing setns process caused: exit status 1: unknown";

  const state = (overrides: Partial<ContainerState> = {}): ContainerState => ({
    running: true,
    status: "running",
    exitCode: 0,
    oomKilled: false,
    health: "unhealthy",
    lastHealthProbe: { exitCode: -1, output: EXEC_FAILURE_OUTPUT },
    ...overrides,
  });
  const probe = (exitCode: number, output: string) => ({
    lastHealthProbe: { exitCode, output },
  });
  const imageFaultPastTheDisplayedReason = `OCI runtime exec failed: exec failed: unable to start container process: ${"x".repeat(300)} exec: "/healthcheck.sh": permission denied: unknown`;

  const accepted: ReadonlyArray<readonly [string, ContainerState]> = [
    ["the exec-start failure Docker records on a sandboxed host", state()],
    [
      "the same failure while Docker still reports the health as starting",
      state({ health: "starting" }),
    ],
    ["the older runc wording of the same failure", state(probe(-1, OLDER_RUNC_EXEC_FAILURE))],
    [
      "a cgroup path the host never created",
      state(
        probe(
          -1,
          "OCI runtime exec failed: exec failed: unable to start container process: error adding pid 123 to cgroups: failed to write 123: openat2 /sys/fs/cgroup/docker/abc/cgroup.procs: no such file or directory: unknown",
        ),
      ),
    ],
    [
      "a namespace file the host never exposed",
      state(
        probe(
          -1,
          "OCI runtime exec failed: exec failed: unable to start container process: error executing setns process: open /proc/123/ns/mnt: no such file or directory: unknown",
        ),
      ),
    ],
    [
      "runc unable to re-exec itself to enter the container",
      state(
        probe(
          -1,
          "OCI runtime exec failed: exec failed: unable to start container process: error executing setns process: fork/exec /proc/self/exe: permission denied: unknown",
        ),
      ),
    ],
  ];
  for (const [scenario, input] of accepted) {
    it(`detects ${scenario}`, () => {
      expect(healthCheckCannotExec(input)).toBe(true);
    });
  }

  const rejected: ReadonlyArray<readonly [string, ContainerState]> = [
    ["a probe that outlived its timeout", state(probe(-1, PROBE_TIMEOUT_OUTPUT))],
    [
      "a missing healthcheck binary",
      state(
        probe(
          -1,
          'OCI runtime exec failed: exec failed: unable to start container process: exec: "pg_isready": executable file not found in $PATH: unknown',
        ),
      ),
    ],
    [
      "a healthcheck binary path that does not exist",
      state(
        probe(
          -1,
          'OCI runtime exec failed: exec failed: unable to start container process: exec: "/usr/bin/pg_isready": stat /usr/bin/pg_isready: no such file or directory: unknown',
        ),
      ),
    ],
    [
      "a healthcheck binary built for another architecture",
      state(
        probe(
          -1,
          "OCI runtime exec failed: exec failed: unable to start container process: exec /usr/bin/pg_isready: exec format error: unknown",
        ),
      ),
    ],
    [
      "a healthcheck script that is not executable",
      state(
        probe(
          -1,
          'OCI runtime exec failed: exec failed: unable to start container process: exec: "/healthcheck.sh": permission denied: unknown',
        ),
      ),
    ],
    [
      "a healthcheck script the kernel cannot open",
      state(
        probe(
          -1,
          "OCI runtime exec failed: exec failed: unable to start container process: exec /healthcheck.sh: permission denied: unknown",
        ),
      ),
    ],
    [
      "a healthcheck script whose shebang interpreter is missing",
      state(
        probe(
          -1,
          "OCI runtime exec failed: exec failed: unable to start container process: exec /healthcheck.sh: no such file or directory: unknown",
        ),
      ),
    ],
    [
      "an image fault that only appears after the first 300 characters",
      state(probe(-1, imageFaultPastTheDisplayedReason)),
    ],
    [
      "an exec into a stopped container",
      state(
        probe(
          -1,
          "OCI runtime exec failed: exec failed: cannot exec in a stopped container: unknown",
        ),
      ),
    ],
    ["a stopped container that once failed to exec", state({ running: false, status: "exited" })],
    ["a restarting container", state({ status: "restarting" })],
    ["a container Docker already reports healthy", state({ health: "healthy" })],
    ["a probe that failed with an ordinary exit code", state(probe(1, EXEC_FAILURE_OUTPUT))],
    ["a container with no recorded probe", state({ lastHealthProbe: undefined })],
  ];
  for (const [scenario, input] of rejected) {
    it(`does not mistake ${scenario} for an exec failure`, () => {
      expect(healthCheckCannotExec(input)).toBe(false);
    });
  }
});

describe("formatNotReadyReason", () => {
  const unhealthy: ContainerState = {
    running: true,
    status: "running",
    exitCode: 0,
    oomKilled: false,
    health: "unhealthy",
  };

  it("is the bare health status when Docker recorded no probe", () => {
    expect(formatNotReadyReason({ ...unhealthy, health: "starting" })).toBe(
      "container is not ready: starting",
    );
  });

  it("appends the last probe's exit code and output", () => {
    expect(
      formatNotReadyReason({
        ...unhealthy,
        lastHealthProbe: { exitCode: -1, output: PROBE_TIMEOUT_OUTPUT },
      }),
    ).toBe(
      "container is not ready: unhealthy (last health check exit code -1: Health check exceeded timeout (2s))",
    );
  });

  it("appends only the exit code when the probe printed nothing", () => {
    expect(
      formatNotReadyReason({ ...unhealthy, lastHealthProbe: { exitCode: 1, output: "" } }),
    ).toBe("container is not ready: unhealthy (last health check exit code 1)");
  });
});

describe("listVolumesByLabel", () => {
  it.live("returns volume names for a successful listing", () => {
    const mock = mockSpawner({ stdout: "supabase_db_my-app\n" });
    return listVolumesByLabel(mock.spawner, "com.supabase.cli.project=my-app").pipe(
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
    return listVolumesByLabel(mock.spawner, "com.supabase.cli.project").pipe(
      Effect.map((names) => {
        expect(names).toEqual([]);
      }),
    );
  });

  it.live("fails with DockerLifecycleListError on a non-zero exit", () => {
    const mock = mockSpawner({ exitCode: 1, stderr: "boom\n" });
    return listVolumesByLabel(mock.spawner, "com.supabase.cli.project").pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(DockerLifecycleListError);
        expect(error.message).toBe("failed to list volumes: boom");
      }),
    );
  });

  it.live("fails with a generic message when stderr is empty", () => {
    const mock = mockSpawner({ exitCode: 1, stderr: "" });
    return listVolumesByLabel(mock.spawner, "com.supabase.cli.project").pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(DockerLifecycleListError);
        expect(error.message).toBe("failed to list volumes");
      }),
    );
  });
});
