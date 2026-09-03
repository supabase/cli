import { createReadStream } from "node:fs";
import { BunStream } from "@effect/platform-bun";
import { Duration, Effect, Layer, Option, Scope, Stream } from "effect";
import { systemError, type PlatformError } from "effect/PlatformError";

import { Tty } from "./tty.service.ts";
import { Stdin } from "./stdin.service.ts";

// Bun's `process.stdin` cannot be throttled: one prompt is enough to start a read of the
// pipe that `pause`, `destroy` and detaching the listener all fail to stop, so an unbounded
// producer (`yes | supabase db push`) turns into an OOM kill. A file stream over fd 0 (the
// path is ignored once `fd` is given) honours backpressure: it reads at most one chunk ahead
// and leaves the rest in the pipe for a child inheriting fd 0 (kept open: `autoClose`,
// `closeOnDone`).
// Ref: https://github.com/supabase/cli/issues/6287
const processStdin: Stream.Stream<Uint8Array, PlatformError> = BunStream.fromReadable({
  evaluate: () => createReadStream("", { fd: 0, autoClose: false }),
  onError: (cause) =>
    systemError({
      module: "Stdin",
      method: "read",
      _tag: "Unknown",
      description: cause instanceof Error ? cause.message : String(cause),
      cause,
    }),
  closeOnDone: false,
});

// `splitLines` holds a partial line until its terminator arrives, so a producer that never
// sends one (`yes | tr -d '\n' | …`) would grow that buffer for as long as a prompt keeps
// pulling. Past this many bytes since the last line break (Go's `bufio.Scanner` limit), the
// next pull fails for good and every prompt from then on takes its default.
const MAX_PENDING_LINE_BYTES = 64 * 1024;

const boundPendingLine = (bytes: Stream.Stream<Uint8Array, PlatformError>) =>
  Stream.transformPull(bytes, (pull) =>
    Effect.sync(() => {
      let pending = 0;
      const tooLong = Effect.fail(
        systemError({
          module: "Stdin",
          method: "readLine",
          _tag: "InvalidData",
          description: `no line break within ${MAX_PENDING_LINE_BYTES} bytes`,
        }),
      );
      return Effect.suspend(() =>
        pending > MAX_PENDING_LINE_BYTES
          ? tooLong
          : Effect.map(pull, (chunk) => {
              for (const part of chunk) {
                const lineEnd = Math.max(part.lastIndexOf(10), part.lastIndexOf(13));
                pending = lineEnd === -1 ? pending + part.length : part.length - lineEnd - 1;
              }
              return chunk;
            }),
      );
    }),
  );

const makeStdin = Effect.fnUntraced(function* (stdin: Stream.Stream<Uint8Array, PlatformError>) {
  const tty = yield* Tty;
  const textDecoder = new TextDecoder();

  const scope = yield* Effect.scope;
  const lineStream = stdin.pipe(boundPendingLine, Stream.decodeText(), Stream.splitLines);

  const lineReader = Effect.gen(function* () {
    const pull = yield* Stream.toPull(lineStream).pipe(Scope.provide(scope));
    // EOF, read errors and the line bound arrive as typed failures and become the prompt's
    // default; a defect or an interrupt propagates rather than silently answering a prompt.
    const nextChunk = pull.pipe(Effect.orElseSucceed(() => []));
    // The last pulled chunk (a single pull may yield several lines) and the next line in it.
    let lines: ReadonlyArray<string> = [];
    let next = 0;
    return Effect.gen(function* () {
      if (next >= lines.length) {
        lines = yield* nextChunk;
        next = 0;
      }
      const line = lines[next];
      next += 1;
      return Option.fromUndefinedOr(line);
    });
  });

  // Persistent, lazily-opened line reader shared by every `readLine` call, so a
  // command issuing several prompts (config push, seed buckets) reads the *next* piped
  // line each time instead of restarting from the top of the pipe. Opening it is
  // deferred behind `Effect.cached` and tied to this layer's scope: stdin is not
  // touched until the first `readLine`, so a TTY command that only prompts via clack
  // never grabs the keyboard (no contention with clack's own stdin capture), and the
  // reader outlives individual prompts. `splitLines` preserves interior blank lines so
  // answers stay aligned across prompts.
  const nextLine = yield* Effect.cached(lineReader);

  const readPipedBytes = Effect.gen(function* () {
    const chunks = yield* stdin.pipe(Stream.runCollect);
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
  const pipedBytesStream = stdin;

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

/** `Stdin` over an arbitrary byte source, so tests can drive it with a controlled stream. */
export const stdinLayerFrom = (stdin: Stream.Stream<Uint8Array, PlatformError>) =>
  Layer.effect(Stdin, makeStdin(stdin));

export const stdinLayer = stdinLayerFrom(processStdin);
