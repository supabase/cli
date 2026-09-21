import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { Effect, Stream } from "effect";

export const cleanupDockerRoot = Effect.fn("DockerTest.cleanupRoot")((root: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(
          "docker",
          [
            "run",
            "--rm",
            "--user",
            "0",
            "--mount",
            `type=bind,src=${root},dst=/mnt`,
            "busybox:1.36",
            "find",
            "/mnt",
            "-mindepth",
            "1",
            "-delete",
          ],
          { stdout: "pipe", stderr: "pipe" },
        ),
      );
      const [output, code] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(child.all)), child.exitCode],
        { concurrency: "unbounded" },
      );
      if (Number(code) !== 0)
        return yield* Effect.die(`Docker test cleanup exited with ${code}: ${output}`);
    }),
  ).pipe(Effect.catchCause(Effect.die)),
);
