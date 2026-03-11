import { Effect, Layer, Option, Stdio, Stream } from "effect";

import { Tty } from "./tty.service.ts";
import { Stdin } from "./stdin.service.ts";

const makeStdin = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const tty = yield* Tty;

  return Stdin.of({
    isTTY: tty.stdinIsTty,
    readPipedToken: Effect.gen(function* () {
      const chunks = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.runCollect);
      const token = Array.from(chunks).join("").trim();
      return token ? Option.some(token) : Option.none();
    }).pipe(Effect.orElseSucceed(() => Option.none())),
  });
});

export const stdinLayer = Layer.effect(Stdin, makeStdin);
