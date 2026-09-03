import type { Effect, Option, Stream } from "effect";
import { Context } from "effect";
import type { PlatformError } from "effect/PlatformError";

interface StdinShape {
  readonly isTTY: boolean;
  readonly readPipedBytes: Effect.Effect<Option.Option<Uint8Array>>;
  /**
   * Piped stdin as a byte stream, for consumers that must avoid buffering the whole
   * pipe (e.g. `migration new` seeding a file from a large `pg_dump`, matching Go's
   * `io.Copy` streaming). Unlike {@link readPipedBytes}, read errors PROPAGATE on the
   * error channel — Go's `io.Copy` returns `failed to copy from stdin` and exits
   * non-zero rather than writing a truncated file, so the caller must map the failure.
   * Emits nothing for an empty pipe; callers gate on {@link isTTY} themselves (a TTY
   * should not be drained).
   */
  readonly pipedBytesStream: Stream.Stream<Uint8Array, PlatformError>;
  readonly readPipedText: Effect.Effect<Option.Option<string>>;
  /**
   * Reads the *next* line from stdin (trimmed), bounded by `timeoutMillis` — callers
   * pass 10 minutes on a TTY and 100 ms otherwise. Backed by a single persistent,
   * lazily-opened reader, so successive calls return successive lines: a command
   * issuing several confirmations answers each from the next piped line. stdin is not
   * opened until the first call, so a command that only prompts on a TTY (via clack)
   * never grabs the keyboard. A timeout, EOF, or a read error all return `None`, which
   * every caller treats as no input and answers with the prompt's default. Unlike
   * {@link readPipedText} (a whole-stream collect), this reads line by line, so it
   * works for an interactive terminal as well as a pipe.
   *
   * stdin is read only as far as the prompts ask, so a producer that outruns them stays in
   * the pipe. A read error, or more than 64 KiB without a line break (see `stdin.layer.ts`),
   * ends line reading the way EOF does: that prompt and every later one get `None`.
   */
  readonly readLine: (timeoutMillis: number) => Effect.Effect<Option.Option<string>>;
}

export class Stdin extends Context.Service<Stdin, StdinShape>()("supabase/runtime/Stdin") {}
