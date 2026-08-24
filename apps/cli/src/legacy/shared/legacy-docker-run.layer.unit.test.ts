import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Layer, Option, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { mockProcessControl } from "../../../tests/helpers/mocks.ts";
import { legacyDockerRunLayer } from "./legacy-docker-run.layer.ts";
import { LegacyDockerRun } from "./legacy-docker-run.service.ts";

const opts = {
  image: "supabase/postgres:17",
  cmd: ["echo", "ok"],
  env: {},
  binds: ["cache-volume:/cache", "/tmp/project:/workspace"],
  workingDir: Option.some("/workspace"),
  securityOpt: ["seccomp=unconfined"],
  extraHosts: [],
  network: { _tag: "host" as const },
  skipImageResolve: true,
};

function mockSpawner() {
  const spawned: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args : [];
      spawned.push(args);
      const exitCode = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitCode, ChildProcessSpawner.ExitCode(0));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: Deferred.await(exitCode),
        isRunning: Effect.succeed(false),
        stdin: Sink.drain,
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, spawned };
}

function runWithEnvironment(
  ambient: Record<string, string>,
  containerEnv: Readonly<Record<string, string>> = {},
  operation: "run" | "capture" | "stream" = "run",
) {
  const mock = mockSpawner();
  const processControl = mockProcessControl();
  const configProvider = ConfigProvider.fromEnv({ env: ambient });
  const layer = legacyDockerRunLayer.pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, mock.spawner)),
    Layer.provide(processControl.layer),
    Layer.provide(Layer.succeed(ConfigProvider.ConfigProvider, configProvider)),
  );
  return {
    mock,
    program: Effect.gen(function* () {
      const docker = yield* LegacyDockerRun;
      const runOpts = { ...opts, env: containerEnv };
      if (operation === "capture") {
        yield* docker.runCapture(runOpts);
      } else if (operation === "stream") {
        yield* docker.runStream(runOpts, { onStdout: () => Effect.void });
      } else {
        yield* docker.run(runOpts);
      }
    }).pipe(Effect.provide(layer)),
  };
}

describe("legacyDockerRunLayer", () => {
  it.live("uses the ambient Bitbucket marker when container env is empty", () => {
    const { mock, program } = runWithEnvironment({ BITBUCKET_CLONE_DIR: "/build" });
    return program.pipe(
      Effect.map(() => {
        const args = mock.spawned[0] ?? [];
        expect(args).toContain("/tmp/project:/workspace");
        expect(args).not.toContain("cache-volume:/cache");
        expect(args).not.toContain("--security-opt");
      }),
    );
  });

  it.live("does not treat a container-only Bitbucket marker as ambient context", () => {
    const { mock, program } = runWithEnvironment({}, { BITBUCKET_CLONE_DIR: "/container" });
    return program.pipe(
      Effect.map(() => {
        const args = mock.spawned[0] ?? [];
        expect(args).toContain("cache-volume:/cache");
        expect(args).toContain("--security-opt");
      }),
    );
  });

  it.live("applies the ambient marker consistently to capture and stream", () => {
    const capture = runWithEnvironment({ BITBUCKET_CLONE_DIR: "/build" }, {}, "capture");
    const stream = runWithEnvironment({ BITBUCKET_CLONE_DIR: "/build" }, {}, "stream");
    return Effect.all([capture.program, stream.program]).pipe(
      Effect.map(() => {
        for (const spawned of [capture.mock.spawned, stream.mock.spawned]) {
          const args = spawned[0] ?? [];
          expect(args).not.toContain("cache-volume:/cache");
          expect(args).not.toContain("--security-opt");
        }
      }),
    );
  });
});
