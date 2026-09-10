import type { Effect, Option, Stream } from "effect";
import { Context } from "effect";
import type { PlatformError } from "effect/PlatformError";

/**
 * The process's stdin. `readPipedBytes`, `readPipedText`, `pipedBytesStream` and `readLine`
 * each read fd 0 through a buffered reader of their own, so bytes one of them has read ahead
 * are gone for the others: a command must use only one of them per invocation (`readLine` may
 * be called repeatedly; its calls share a single reader).
 */
interface StdinShape {
  readonly isTTY: boolean;
  readonly readPipedBytes: Effect.Effect<Option.Option<Uint8Array>>;
  /**
   * Piped stdin as a byte stream, for consumers that must avoid buffering the whole pipe
   * (e.g. `migration new` seeding a file from a large `pg_dump`). Unlike {@link readPipedBytes},
   * read errors PROPAGATE so a caller writing the bytes to a file fails rather than leaving a
   * truncated one. Emits nothing for an empty pipe; callers gate on {@link isTTY} themselves.
   */
  readonly pipedBytesStream: Stream.Stream<Uint8Array, PlatformError>;
  readonly readPipedText: Effect.Effect<Option.Option<string>>;
  /**
   * Reads the *next* line from stdin (trimmed), bounded by `timeoutMillis` — callers pass 10
   * minutes on a TTY and 100 ms otherwise. Backed by a single persistent, lazily-opened
   * reader, so successive calls return successive lines and a command that only prompts on a
   * TTY never grabs stdin before it needs to. A timeout, EOF, or a read error all return
   * `None`, which every caller treats as the prompt's default. Unlike {@link readPipedText}
   * (a whole-stream collect), this reads line by line, so it works on a TTY as well as a pipe.
   */
  readonly readLine: (timeoutMillis: number) => Effect.Effect<Option.Option<string>>;
}

export class Stdin extends Context.Service<Stdin, StdinShape>()("supabase/runtime/Stdin") {}
