import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, PlatformError, Sink, Stream, Tracer } from "effect";
import { ChildProcessSpawner } from "effect/process";

import {
  containerCliExitCode,
  containerRuntimeNotFoundMessage,
  describeContainerCliFailure,
  dockerSupportsVolumePruneAllFlag,
  isContainerNotFoundMessage,
  spawnContainerCli,
} from "./container-cli.ts";

function mockSpawner(
  opts: {
    readonly dockerMissing?: boolean;
    readonly bothMissing?: boolean;
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly apiVersions?: { readonly client: string; readonly server: string };
  } = {},
) {
  const spawned: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const cmd = command._tag === "StandardCommand" ? command.command : "";
      const args = command._tag === "StandardCommand" ? command.args : [];
      spawned.push({ command: cmd, args });

      if ((opts.dockerMissing && cmd === "docker") || opts.bothMissing === true) {
        return yield* PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: `${cmd} not found`,
        });
      }

      const stdout =
        opts.apiVersions !== undefined && args[0] === "version"
          ? (args[args.indexOf("--format") + 1] ?? "")
              .replaceAll("{{.Client.APIVersion}}", opts.apiVersions.client)
              .replaceAll("{{.Server.APIVersion}}", opts.apiVersions.server)
          : opts.stdout;

      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(opts.exitCode ?? 0));

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout:
          stdout !== undefined
            ? Stream.fromIterable([new TextEncoder().encode(stdout)])
            : Stream.empty,
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

  return {
    spawner,
    get spawned() {
      return spawned;
    },
  };
}

describe("spawnContainerCli", () => {
  it.live("spawns docker and does not touch podman when docker is available", () => {
    const mock = mockSpawner();
    return spawnContainerCli(mock.spawner, ["pull", "supabase/postgres:17"]).pipe(
      Effect.scoped,
      Effect.map(() => {
        expect(mock.spawned).toEqual([
          { command: "docker", args: ["pull", "supabase/postgres:17"] },
        ]);
      }),
    );
  });

  it.live("falls back to podman when the docker executable cannot be spawned", () => {
    const mock = mockSpawner({ dockerMissing: true });
    return spawnContainerCli(mock.spawner, ["pull", "supabase/postgres:17"]).pipe(
      Effect.scoped,
      Effect.map(() => {
        expect(mock.spawned).toEqual([
          { command: "docker", args: ["pull", "supabase/postgres:17"] },
          { command: "podman", args: ["pull", "supabase/postgres:17"] },
        ]);
      }),
    );
  });
});

describe("containerCliExitCode", () => {
  it.live("resolves docker's exit code without trying podman when docker runs", () => {
    const mock = mockSpawner({ exitCode: 0 });
    return containerCliExitCode(mock.spawner, ["image", "inspect", "img"]).pipe(
      Effect.map((exitCode) => {
        expect(exitCode).toBe(0);
        expect(mock.spawned.map((entry) => entry.command)).toEqual(["docker"]);
      }),
    );
  });

  it.live("falls back to podman's exit code when the docker executable is missing", () => {
    const mock = mockSpawner({ dockerMissing: true, exitCode: 1 });
    return containerCliExitCode(mock.spawner, ["image", "inspect", "img"]).pipe(
      Effect.map((exitCode) => {
        expect(exitCode).toBe(1);
        expect(mock.spawned.map((entry) => entry.command)).toEqual(["docker", "podman"]);
      }),
    );
  });

  it.live("fails with a clear message when neither docker nor podman can be spawned", () => {
    const mock = mockSpawner({ bothMissing: true });
    return containerCliExitCode(mock.spawner, ["image", "inspect", "img"]).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(describeContainerCliFailure(error)).toBe(containerRuntimeNotFoundMessage);
      }),
    );
  });
});

describe("container CLI process spans", () => {
  const recordedAttributes = (args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      yield* containerCliExitCode(mockSpawner().spawner, args).pipe(
        Effect.withTracer(tracer),
        Effect.withTracerEnabled(true),
      );
      return Object.fromEntries(spans.find((span) => span.name === "ContainerCli.run")!.attributes);
    });

  it.live("records the docker verb but no free-form arguments", () =>
    recordedAttributes(["container", "inspect", "supabase_db_secret-project"]).pipe(
      Effect.map((attributes) => {
        expect(attributes).toEqual({
          "process.executable.name": "docker",
          "process.arg_count": 3,
          "process.subcommand": "container inspect",
          "process.exit_code": 0,
        });
      }),
    ),
  );

  it.live("labels an unknown leading argument as other", () =>
    recordedAttributes(["--context", "my-private-context", "ps"]).pipe(
      Effect.map((attributes) => {
        expect(attributes["process.subcommand"]).toBe("other");
      }),
    ),
  );

  it.live("records a missing docker as a failed attempt, not a failed span, on podman hosts", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const mock = mockSpawner({ dockerMissing: true });

      yield* containerCliExitCode(mock.spawner, ["ps"]).pipe(
        Effect.andThen(spawnContainerCli(mock.spawner, ["ps"]).pipe(Effect.scoped)),
        Effect.withTracer(tracer),
        Effect.withTracerEnabled(true),
      );

      const docker = spans.filter(
        (span) => span.attributes.get("process.executable.name") === "docker",
      );
      expect(docker.map((span) => span.name)).toEqual(["ContainerCli.run", "ContainerCli.spawn"]);
      expect(docker.map((span) => span.attributes.get("process.attempt_failed"))).toEqual([
        true,
        true,
      ]);
      expect(
        spans.map((span) => span.status._tag === "Ended" && Exit.isSuccess(span.status.exit)),
      ).toEqual([true, true, true, true]);
    }),
  );

  it.live("fails the podman span when neither runtime can be spawned", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });

      yield* containerCliExitCode(mockSpawner({ bothMissing: true }).spawner, ["ps"]).pipe(
        Effect.ignore,
        Effect.withTracer(tracer),
        Effect.withTracerEnabled(true),
      );

      const podman = spans.find(
        (span) => span.attributes.get("process.executable.name") === "podman",
      );
      expect(podman?.status._tag === "Ended" && Exit.isFailure(podman.status.exit)).toBe(true);
    }),
  );
});

describe("dockerSupportsVolumePruneAllFlag", () => {
  it.live(
    "returns true when the client and daemon both report an API version at or above 1.42",
    () => {
      const mock = mockSpawner({ apiVersions: { client: "1.42", server: "1.51" } });
      return dockerSupportsVolumePruneAllFlag(mock.spawner).pipe(
        Effect.map((supportsAll) => {
          expect(supportsAll).toBe(true);
          expect(mock.spawned).toEqual([
            {
              command: "docker",
              args: ["version", "--format", "{{.Client.APIVersion}} {{.Server.APIVersion}}"],
            },
          ]);
        }),
      );
    },
  );

  it.live("returns false for an old client against a new daemon", () => {
    const mock = mockSpawner({ apiVersions: { client: "1.41", server: "1.44" } });
    return dockerSupportsVolumePruneAllFlag(mock.spawner).pipe(
      Effect.map((supportsAll) => {
        expect(supportsAll).toBe(false);
      }),
    );
  });

  it.live.each([
    {
      name: "a new client against an old daemon",
      options: { apiVersions: { client: "1.44", server: "1.41" } },
    },
    {
      name: "versions that only compare above 1.42 lexicographically",
      options: { apiVersions: { client: "1.9", server: "1.9" } },
    },
    { name: "a single version instead of a client and daemon pair", options: { stdout: "1.51" } },
    { name: "more than two versions", options: { stdout: "1.51 1.51 1.51" } },
    { name: "empty output", options: { stdout: "" } },
  ])("returns false for $name", ({ options }) => {
    const mock = mockSpawner(options);
    return dockerSupportsVolumePruneAllFlag(mock.spawner).pipe(
      Effect.map((supportsAll) => {
        expect(supportsAll).toBe(false);
      }),
    );
  });

  it.live("returns false when the version command exits non-zero", () => {
    const mock = mockSpawner({ exitCode: 1, apiVersions: { client: "1.51", server: "1.51" } });
    return dockerSupportsVolumePruneAllFlag(mock.spawner).pipe(
      Effect.map((supportsAll) => {
        expect(supportsAll).toBe(false);
      }),
    );
  });

  it.live("returns false without falling back to podman when docker cannot be spawned", () => {
    const mock = mockSpawner({ dockerMissing: true });
    return dockerSupportsVolumePruneAllFlag(mock.spawner).pipe(
      Effect.map((supportsAll) => {
        expect(supportsAll).toBe(false);
        expect(mock.spawned.map((entry) => entry.command)).toEqual(["docker"]);
      }),
    );
  });
});

describe("describeContainerCliFailure", () => {
  it.live("describes a both-runtimes-missing failure with its clear message", () => {
    const mock = mockSpawner({ bothMissing: true });
    return containerCliExitCode(mock.spawner, ["ps"]).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(describeContainerCliFailure(error)).toContain(containerRuntimeNotFoundMessage);
      }),
    );
  });

  it("falls back to an Error instance's own message", () => {
    expect(describeContainerCliFailure(new Error("boom"))).toBe("boom");
  });

  it("stringifies a non-Error cause", () => {
    expect(describeContainerCliFailure("boom")).toBe("boom");
    expect(describeContainerCliFailure(42)).toBe("42");
  });
});

describe("isContainerNotFoundMessage", () => {
  it("recognizes Docker's uppercase shapes", () => {
    expect(isContainerNotFoundMessage("Error: No such container: db")).toBe(true);
    expect(isContainerNotFoundMessage("Error: No such object: db")).toBe(true);
  });

  it("recognizes Podman's lowercase shapes, case-insensitively", () => {
    expect(isContainerNotFoundMessage("error: no such container db")).toBe(true);
    expect(isContainerNotFoundMessage("Error: no such object: db")).toBe(true);
  });

  it("recognizes Podman's 'no container with name or ID' shape", () => {
    expect(
      isContainerNotFoundMessage('no container with name or ID "db" found: no such container'),
    ).toBe(true);
    expect(isContainerNotFoundMessage("No container with name or ID db found")).toBe(true);
  });

  it("rejects unrelated failures", () => {
    expect(isContainerNotFoundMessage("Cannot connect to the Docker daemon")).toBe(false);
  });
});
