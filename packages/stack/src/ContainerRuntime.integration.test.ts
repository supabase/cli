import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { selectStackRuntime } from "./ContainerRuntime.ts";

const runtimeSpawner = (availability: Readonly<Record<string, boolean>>) => {
  const commands: string[] = [];
  return {
    commands,
    layer: Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const executable = command._tag === "StandardCommand" ? command.command : "";
          commands.push(executable);
          const exitCode = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
          yield* Deferred.succeed(
            exitCode,
            ChildProcessSpawner.ExitCode(availability[executable] === true ? 0 : 1),
          );
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
      ),
    ),
  };
};

describe("stack runtime selection", () => {
  it.effect("uses Docker mode when the Docker daemon is usable", () => {
    const spawner = runtimeSpawner({ docker: true });
    return Effect.gen(function* () {
      expect(yield* selectStackRuntime()).toEqual({
        mode: "docker",
        containerRuntime: "docker",
      });
      expect(spawner.commands).toEqual(["docker"]);
    }).pipe(Effect.provide(spawner.layer));
  });

  it.effect("uses Podman for Docker mode when Docker is unavailable", () => {
    const spawner = runtimeSpawner({ podman: true });
    return Effect.gen(function* () {
      expect(yield* selectStackRuntime()).toEqual({
        mode: "docker",
        containerRuntime: "podman",
      });
      expect(spawner.commands).toEqual(["docker", "podman"]);
    }).pipe(Effect.provide(spawner.layer));
  });

  it.effect("uses native mode when no container runtime is usable", () => {
    const spawner = runtimeSpawner({});
    return Effect.gen(function* () {
      expect(yield* selectStackRuntime()).toEqual({
        mode: "native",
        containerRuntime: null,
      });
    }).pipe(Effect.provide(spawner.layer));
  });

  it.effect("does not probe container runtimes when native mode is explicit", () => {
    const spawner = runtimeSpawner({ docker: true });
    return Effect.gen(function* () {
      expect(yield* selectStackRuntime("native")).toEqual({
        mode: "native",
        containerRuntime: null,
      });
      expect(spawner.commands).toEqual([]);
    }).pipe(Effect.provide(spawner.layer));
  });

  it.effect("rejects explicit Docker mode when neither runtime is usable", () => {
    const spawner = runtimeSpawner({});
    return Effect.gen(function* () {
      const error = yield* selectStackRuntime("docker").pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "StackBuildError",
        reason: "docker_not_running",
      });
    }).pipe(Effect.provide(spawner.layer));
  });
});
