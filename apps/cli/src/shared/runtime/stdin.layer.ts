import { Effect, Layer, Option, Stdio, Stream } from "effect";

import { Tty } from "./tty.service.ts";
import { Stdin } from "./stdin.service.ts";

const makeStdin = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const tty = yield* Tty;
  const textDecoder = new TextDecoder();

  const readPipedBytes = Effect.gen(function* () {
    const chunks = yield* stdio.stdin.pipe(Stream.runCollect);
    const parts = Array.from(chunks);
    if (parts.length === 0) {
      return Option.none<Uint8Array>();
    }

    const totalSize = parts.reduce((size, chunk) => size + chunk.length, 0);
    if (totalSize === 0) {
      return Option.none<Uint8Array>();
    }

    const bytes = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of parts) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }

    return Option.some(bytes);
  }).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));

  return Stdin.of({
    isTTY: tty.stdinIsTty,
    readPipedBytes,
    readPipedText: readPipedBytes.pipe(
      Effect.map((bytes) => {
        if (Option.isNone(bytes)) {
          return Option.none<string>();
        }
        const text = textDecoder.decode(bytes.value).trim();
        return text ? Option.some(text) : Option.none<string>();
      }),
    ),
  });
});

export const stdinLayer = Layer.effect(Stdin, makeStdin);
