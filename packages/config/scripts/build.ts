import { BunServices } from "@effect/platform-bun";
import { Data, Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { toProjectConfigJsonSchema } from "../src/base.ts";

class BuildError extends Data.TaggedError("BuildError")<{
  readonly cause: unknown;
}> {}

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const json = toProjectConfigJsonSchema();
  const schema = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(json);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const formatted = yield* Effect.scoped(
    Effect.gen(function* () {
      const formatter = yield* spawner.spawn(
        ChildProcess.make("bun", ["x", "oxfmt", "--stdin-filepath=./dist/schema.json"], {
          extendEnv: true,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      yield* Stream.run(Stream.make(new TextEncoder().encode(`${schema}\n`)), formatter.stdin);
      const [exitCode, output, stderr] = yield* Effect.all(
        [
          formatter.exitCode,
          Stream.mkString(Stream.decodeText(formatter.stdout)),
          Stream.mkString(Stream.decodeText(formatter.stderr)),
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        return yield* new BuildError({
          cause: `oxfmt failed with exit code ${exitCode}: ${stderr.trim()}`,
        });
      }
      return output;
    }),
  ).pipe(Effect.mapError((cause) => new BuildError({ cause })));

  yield* fileSystem.makeDirectory("./dist", { recursive: true });
  yield* fileSystem.writeFileString("./dist/schema.json", formatted);
});

await Effect.runPromise(program.pipe(Effect.provide(BunServices.layer)));
