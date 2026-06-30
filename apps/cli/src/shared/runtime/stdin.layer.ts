import { Duration, Effect, Layer, Option, Stdio, Stream } from "effect";

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

  // Read one line (up to the first newline), trimmed, bounded by `timeoutMillis`.
  // Mirrors Go's `Console.ReadLine` (`internal/utils/console.go:38-61`); `Stream.take(1)`
  // stops at the first line so an interactive TTY isn't drained to EOF. A timeout, EOF,
  // or read error all collapse to `None` (Go returns "" — i.e. the default — for each).
  const readLine = (timeoutMillis: number): Effect.Effect<Option.Option<string>> =>
    stdio.stdin.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.take(1),
      Stream.runHead,
      Effect.map(Option.map((line) => line.trim())),
      Effect.timeoutOption(Duration.millis(timeoutMillis)),
      Effect.map(Option.flatten),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  // Stream piped stdin without collecting it (constant memory). Read errors PROPAGATE on
  // the error channel (unlike `readPipedBytes`'s `orElseSucceed(none)` swallow): Go's
  // `io.Copy` returns `failed to copy from stdin` and exits non-zero rather than writing a
  // truncated migration file, so the streaming consumer must surface the failure.
  const pipedBytesStream = stdio.stdin;

  return Stdin.of({
    isTTY: tty.stdinIsTty,
    readPipedBytes,
    pipedBytesStream,
    readPipedText: readPipedBytes.pipe(
      Effect.map((bytes) => {
        if (Option.isNone(bytes)) {
          return Option.none<string>();
        }
        const text = textDecoder.decode(bytes.value).trim();
        return text ? Option.some(text) : Option.none<string>();
      }),
    ),
    readLine,
  });
});

export const stdinLayer = Layer.effect(Stdin, makeStdin);
