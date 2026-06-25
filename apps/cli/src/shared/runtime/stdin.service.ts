import type { Effect, Option } from "effect";
import { Context } from "effect";

interface StdinShape {
  readonly isTTY: boolean;
  readonly readPipedBytes: Effect.Effect<Option.Option<Uint8Array>>;
  readonly readPipedText: Effect.Effect<Option.Option<string>>;
  /**
   * Reads a single line from stdin (up to the first newline), trimmed, bounded by
   * `timeoutMillis`. Port of Go's `Console.ReadLine` (`internal/utils/console.go:38-61`),
   * which reads one line with a 10-minute timeout on a TTY and 100 ms otherwise.
   * Returns `None` on timeout, EOF, or a read error (Go treats all of these as no input).
   * Unlike {@link readPipedText} (a whole-stream collect), this stops at the first line,
   * so it works for an interactive terminal as well as a pipe.
   */
  readonly readLine: (timeoutMillis: number) => Effect.Effect<Option.Option<string>>;
}

export class Stdin extends Context.Service<Stdin, StdinShape>()("supabase/runtime/Stdin") {}
