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
   * Reads the *next* line from stdin (trimmed), bounded by `timeoutMillis`. Port of
   * Go's `Console.ReadLine` (`internal/utils/console.go:38-61`), which reads one line
   * with a 10-minute timeout on a TTY and 100 ms otherwise. Backed by a single
   * persistent, lazily-opened reader, so successive calls return successive lines —
   * a command issuing several confirmations answers each from the next piped line,
   * exactly as Go's one `bufio.Scanner` does. stdin is not opened until the first
   * call, so a command that only prompts on a TTY (via clack) never grabs the
   * keyboard. Returns `None` on timeout, EOF, or a read error (Go treats all of these
   * as no input). Unlike {@link readPipedText} (a whole-stream collect), this reads
   * line by line, so it works for an interactive terminal as well as a pipe.
   */
  readonly readLine: (timeoutMillis: number) => Effect.Effect<Option.Option<string>>;
}

export class Stdin extends Context.Service<Stdin, StdinShape>()("supabase/runtime/Stdin") {}
