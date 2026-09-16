import { createReadStream } from "node:fs";
import { BunStream } from "@effect/platform-bun";
import {
  Channel,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Schedule,
  Scope,
  Stream,
} from "effect";
import { systemError, type PlatformError } from "effect/PlatformError";

import { Tty } from "./tty.service.ts";
import { Stdin } from "./stdin.service.ts";

// fd 0 can be non-blocking (inherited from the parent's open file description), so an empty
// read fails EAGAIN instead of waiting for data.
const isEagain = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "EAGAIN";

// Bun's `process.stdin` can't be throttled (pause/destroy/detach don't stop an inherited pipe
// read), so an unbounded producer OOMs. A file stream over fd 0 honors backpressure instead;
// EAGAIN from the non-blocking fd is reported as WouldBlock for the reader to wait out.
// See https://github.com/supabase/cli/issues/6287
const processStdin: Stream.Stream<Uint8Array, PlatformError> = BunStream.fromReadable({
  evaluate: () => createReadStream("", { fd: 0, autoClose: false }),
  onError: (cause) =>
    systemError({
      module: "Stdin",
      method: "read",
      _tag: isEagain(cause) ? "WouldBlock" : "Unknown",
      description: cause instanceof Error ? cause.message : String(cause),
      cause,
    }),
});

// Bounds the unterminated-line buffer `splitLines` holds: a producer that never sends a line
// break (`yes | tr -d '\n' | …`) would otherwise grow it without limit. Once more bytes than
// this are pending, the next pull fails and every later prompt takes its default.
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
          description: `unterminated line exceeds ${MAX_PENDING_LINE_BYTES} bytes`,
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

  // WouldBlock means the non-blocking fd has nothing to read yet, not that it's broken: retry
  // until data, EOF, or the prompt's timeout interrupts it. Polls at a fixed 10ms rather than
  // backing off, so a slow prompt's wait doesn't carry backoff state into the next one.
  const source = Stream.retry(stdin, ($) =>
    $(Schedule.spaced("10 millis")).pipe(
      Schedule.while(({ input }) => Predicate.isTagged(input.reason, "WouldBlock")),
    ),
  );

  const scope = yield* Effect.scope;
  const lineStream = source.pipe(boundPendingLine, Stream.decodeText(), Stream.splitLines);

  const lineReader = Effect.gen(function* () {
    // One line per pull: `flattenArray` holds the rest of a multi-line chunk for the next
    // pull, and `toPull` serializes pulls, so prompts running at once still take turns.
    const pull = yield* Channel.toPull(Channel.flattenArray(Stream.toChannel(lineStream))).pipe(
      Scope.provide(scope),
    );
    // EOF, read errors and the line bound arrive as typed failures and become the prompt's
    // default; a defect or an interrupt propagates rather than silently answering a prompt.
    return pull.pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
  });

  // Persistent, lazily-opened (via `Effect.cached`) line reader shared by every `readLine`
  // call, so successive prompts read successive piped lines instead of restarting the pipe.
  // Opening is deferred until the first call, so a TTY-only command never grabs stdin from
  // clack. A failed read stays failed: fd 0 problems don't self-heal, so later prompts take
  // their default instead of retrying a dead descriptor.
  const nextLine = yield* Effect.cached(lineReader);

  const readPipedBytes = Effect.gen(function* () {
    const chunks = yield* source.pipe(Stream.runCollect);
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

  // Bounds a pipe that never sends a line, or a user who never answers: a timeout, EOF, or
  // read error all collapse to `None`, the prompt's default.
  const readLine = (timeoutMillis: number): Effect.Effect<Option.Option<string>> =>
    Effect.gen(function* () {
      const take = yield* nextLine;
      // Outer `None` = timed out; inner `None` = EOF / read error; either way the
      // prompt takes its default.
      const line = yield* take.pipe(Effect.timeoutOption(Duration.millis(timeoutMillis)));
      return Option.map(Option.flatten(line), (value) => value.trim());
    });

  // Streams piped stdin without collecting it. Unlike `readPipedBytes`, read errors PROPAGATE
  // so a consumer writing to a file fails rather than leaving a truncated one.
  const pipedBytesStream = source;

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
