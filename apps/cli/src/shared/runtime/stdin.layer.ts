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

// A parent that put the descriptor it hands down as fd 0 in non-blocking mode hands that mode
// down with it (`O_NONBLOCK` belongs to the shared open file, not to each process's descriptor),
// and an empty read then fails with `EAGAIN` instead of waiting for data.
const isEagain = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "EAGAIN";

// Bun's `process.stdin` cannot be throttled: one prompt is enough to start a read of the
// pipe that `pause`, `destroy` and detaching the listener all fail to stop, so an unbounded
// producer (`yes | supabase db push`) turns into an OOM kill. A file stream over fd 0 (the
// path is ignored once `fd` is given) honours backpressure: it reads at most one chunk ahead
// and leaves the rest in the pipe for a child inheriting fd 0, which `autoClose` keeps open
// when the stream is destroyed. Destroying it is what a reader's scope does on the way out:
// left alive, a stream whose listeners are gone would raise its next `EAGAIN` as an uncaught
// error. Clearing `O_NONBLOCK` would clear it for the parent too, so fd 0 is taken as it comes
// and `EAGAIN` is reported as `WouldBlock` for the reader to wait out.
// Ref: https://github.com/supabase/cli/issues/6287
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

// `splitLines` holds a partial line until its terminator arrives, so a producer that never
// sends one (`yes | tr -d '\n' | …`) would grow that buffer for as long as a prompt keeps
// pulling. This bounds it: once more than this many bytes are pending since the last line
// break, the next pull fails instead of reading further, and every prompt from then on takes
// its default. The check runs once per pull, so the buffer runs at most one pull, a chunk or
// two, past this bound before it trips.
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

  // `WouldBlock` is a non-blocking source with nothing to read yet, not a broken one: put a
  // fresh reader over the still-open descriptor and ask again until data or EOF arrives, so the
  // wait ends the way a blocking read's would, or with the prompt's timeout, which interrupts
  // the retry. A poll, since the throttleable fd reader has no readiness signal to wait on;
  // every 10 ms gives a piped prompt's 100 ms window ten looks, and stays fixed because the
  // schedule keeps its state until data arrives, so a backoff reached while one prompt waited
  // would still be slowing the next one down. Each look keeps a retry frame (a few KB) for the
  // reader's lifetime, so a producer that never writes or closes costs a few hundred kilobytes
  // a second of waiting, where a blocking read would hang for free.
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

  // Persistent, lazily-opened line reader shared by every `readLine` call, so a
  // command issuing several prompts (config push, seed buckets) reads the *next* piped
  // line each time instead of restarting from the top of the pipe. Opening it is
  // deferred behind `Effect.cached` and tied to this layer's scope: stdin is not
  // touched until the first `readLine`, so a TTY command that only prompts via clack
  // never grabs the keyboard (no contention with clack's own stdin capture), and the
  // reader outlives individual prompts. `splitLines` preserves interior blank lines so
  // answers stay aligned across prompts. A failed read stays failed for the rest of the
  // process: what can go wrong with an open fd 0 (closed, hung up, not readable) does not
  // mend on its own, so later prompts take their default instead of retrying a dead
  // descriptor; the one transient failure, `WouldBlock`, is waited out upstream.
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

  // Read the next line (trimmed), bounded by `timeoutMillis`, from the persistent reader
  // above: successive calls return successive lines, and a timeout, EOF, or read error all
  // collapse to `None`, the prompt's default. The timeout bounds a pipe that stays open
  // without sending a line, and a user who never answers, so the prompt takes its default
  // instead of waiting for EOF.
  const readLine = (timeoutMillis: number): Effect.Effect<Option.Option<string>> =>
    Effect.gen(function* () {
      const take = yield* nextLine;
      // Outer `None` = timed out; inner `None` = EOF / read error; either way the
      // prompt takes its default.
      const line = yield* take.pipe(Effect.timeoutOption(Duration.millis(timeoutMillis)));
      return Option.map(Option.flatten(line), (value) => value.trim());
    });

  // Stream piped stdin without collecting it (constant memory). Read errors PROPAGATE on
  // the error channel (unlike `readPipedBytes`'s `orElseSucceed(none)` swallow), once
  // `WouldBlock` has been waited out above: a consumer writing the bytes to a file must fail
  // rather than leave a truncated file behind.
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
