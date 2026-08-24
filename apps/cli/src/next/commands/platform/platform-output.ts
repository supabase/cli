import { Effect, Schema, Stream } from "effect";
import * as Stdio from "effect/Stdio";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export function writePlatformJsonStdout(value: unknown) {
  return Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.make(encodeJson(value) + "\n").pipe(Stream.run(stdio.stdout()), Effect.orDie);
  });
}
