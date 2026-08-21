import { Duration, Effect, Layer, Option, Pull, Queue, Ref, Scope, Stdio, Stream } from "effect";

import { Tty } from "./tty.service.ts";
import { Stdin } from "./stdin.service.ts";

const makeStdin = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const tty = yield* Tty;
  const textDecoder = new TextDecoder();

  const scope = yield* Effect.scope;
  const lineStream = stdio.stdin.pipe(Stream.decodeText(), Stream.splitLines);

  // A TTY answers at human speed, so it keeps the on-demand pull: nothing is read
  // between prompts, leaving the keyboard to whatever reads stdin next.
  const ttyLineReader = Effect.gen(function* () {
    const pull = yield* Stream.toPull(lineStream).pipe(Scope.provide(scope));
    // Leftover lines from the last pulled chunk (a single pull may yield several).
    const bufferRef = yield* Ref.make<ReadonlyArray<string>>([]);
    return Effect.gen(function* () {
      const buffered = yield* Ref.get(bufferRef);
      if (buffered.length > 0) {
        yield* Ref.set(bufferRef, buffered.slice(1));
        return Option.some(buffered[0] ?? "");
      }
      return yield* Pull.matchEffect(pull, {
        onSuccess: (chunk) =>
          Ref.set(bufferRef, chunk.slice(1)).pipe(Effect.as(Option.some(chunk[0] ?? ""))),
        onFailure: () => Effect.succeedNone,
        onDone: () => Effect.succeedNone,
      });
    });
  });

  // A pipe is read ahead into a bounded queue instead, because Bun's `process.stdin`
  // cannot be throttled: one prompt is enough to start a read of the pipe that `pause`,
  // `destroy` and detaching the listener all fail to stop. Everything left unconsumed
  // accumulates for the rest of the command, which an unbounded producer turns into an
  // OOM kill; consuming as fast as the pipe fills keeps memory flat. `dropping` discards
  // the newest overflow, so the lines prompts read stay in pipe order.
  // Ref: https://github.com/supabase/cli/issues/6287
  const pipedLineReader = Stream.toQueue(lineStream, {
    // The pump reads at pipe speed, so this is in effect how many piped answers one run
    // can use. `seed buckets` and `storage rm` prompt once per bucket, so it is sized to
    // a project's bucket count rather than to a fixed handful of confirmations.
    capacity: 1024,
    strategy: "dropping",
  }).pipe(
    Scope.provide(scope),
    Effect.map((queue) =>
      // EOF and read errors arrive as typed failures and become the prompt's default;
      // a defect or an interrupt propagates rather than silently answering a prompt.
      Queue.take(queue).pipe(
        Effect.map(Option.some),
        Effect.orElseSucceed(() => Option.none<string>()),
      ),
    ),
  );

  // Persistent, lazily-opened line reader shared by every `readLine` call, so a
  // command issuing several prompts (config push, seed buckets) reads the *next*
  // piped line each time — one `bufio.Scanner` over os.Stdin, as in Go
  // (`internal/utils/console.go:20,50`). Opening it is deferred behind
  // `Effect.cached` and tied to this layer's scope: stdin is not touched until the
  // first `readLine`, so a TTY command that only prompts via clack never grabs the
  // keyboard (no contention with clack's own stdin capture), and the reader outlives
  // individual prompts. `splitLines` preserves interior blank lines so answers stay
  // aligned across prompts.
  const nextLine = yield* Effect.cached(tty.stdinIsTty ? ttyLineReader : pipedLineReader);

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
      const take = yield* nextLine;
      // Outer `None` = timed out; inner `None` = EOF / read error; either way the
      // prompt takes its default.
      const line = yield* take.pipe(Effect.timeoutOption(Duration.millis(timeoutMillis)));
      return Option.map(Option.flatten(line), (value) => value.trim());
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
