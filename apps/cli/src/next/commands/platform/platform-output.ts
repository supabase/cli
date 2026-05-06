import { Effect, Stream } from "effect";
import * as Stdio from "effect/Stdio";

export function writePlatformJsonStdout(value: unknown) {
  return Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(JSON.stringify(value) + "\n").pipe(Stream.run(stdio.stdout()), Effect.orDie);
  });
}
