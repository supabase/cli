import { Duration, Effect, Layer, Option, Pull, Ref, Scope, Stdio, Stream } from "effect";

import { Tty } from "./tty.service.ts";
import { Stdin } from "./stdin.service.ts";

const makeStdin = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const tty = yield* Tty;
  const textDecoder = new TextDecoder();

  // Persistent, lazily-opened line reader shared by every `readLine` call, so a
  // command issuing several prompts (config push, seed buckets) reads the *next*
  // piped line each time — one `bufio.Scanner` over os.Stdin, as in Go
  // (`internal/utils/console.go:20,50`). `Stream.toPull` is deferred behind
  // `Effect.cached` and tied to this layer's scope: stdin is not touched until the
  // first `readLine`, so a TTY command that only prompts via clack never grabs the
  // keyboard (no contention with clack's own stdin capture), and the pull outlives
  // individual prompts. `splitLines` preserves interior blank lines so answers stay
  // aligned across prompts.
  const scope = yield* Effect.scope;
  const getPull = yield* Effect.cached(
    Stream.toPull(stdio.stdin.pipe(Stream.decodeText(), Stream.splitLines)).pipe(
      Scope.provide(scope),
    ),
  );
  // Leftover lines from the last pulled chunk (a single pull may yield several).
  const bufferRef = yield* Ref.make<ReadonlyArray<string>>([]);

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

  // Read the next line (trimmed), bounded by `timeoutMillis`, from the persistent
  // reader above. Mirrors Go's `Console.ReadLine` (`internal/utils/console.go:38-61`):
  // successive calls return successive lines, and a timeout, EOF, or read error all
  // collapse to `None` (Go returns "" — i.e. the prompt default — for each). The
  // timeout bounds an open pipe that yields no newline (e.g. `yes y | …`) so it takes
  // the default instead of blocking on EOF.
  const readLine = (timeoutMillis: number): Effect.Effect<Option.Option<string>> =>
    Effect.gen(function* () {
      const buffered = yield* Ref.get(bufferRef);
      if (buffered.length > 0) {
        yield* Ref.set(bufferRef, buffered.slice(1));
        return Option.some((buffered[0] ?? "").trim());
      }
      const pull = yield* getPull;
      const readChunk = Pull.matchEffect(pull, {
        onSuccess: (chunk) => Effect.succeed(Option.some(chunk)),
        onFailure: () => Effect.succeedNone,
        onDone: () => Effect.succeedNone,
      });
      // Outer `None` = timed out; inner `None` = EOF / read error; either way the
      // prompt takes its default.
      const pulled = yield* readChunk.pipe(Effect.timeoutOption(Duration.millis(timeoutMillis)));
      if (Option.isNone(pulled) || Option.isNone(pulled.value)) {
        return Option.none<string>();
      }
      const chunk = pulled.value.value;
      yield* Ref.set(bufferRef, chunk.slice(1));
      return Option.some((chunk[0] ?? "").trim());
    });

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
