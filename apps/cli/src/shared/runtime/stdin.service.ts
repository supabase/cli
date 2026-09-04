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
   * Piped stdin as a byte stream, for consumers that must avoid buffering the whole
   * pipe (e.g. `migration new` seeding a file from a large `pg_dump`). Unlike
   * {@link readPipedBytes}, read errors PROPAGATE on the error channel (once a non-blocking
   * fd 0 with nothing to read yet has been waited out): a caller writing the bytes to a file
   * must fail rather than leave a truncated file behind, so it maps the failure itself. Emits
   * nothing for an empty pipe; callers gate on {@link isTTY} themselves (a TTY should not be
   * drained).
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
   * stdin is pulled a chunk (64 KiB) at a time and only when a prompt needs a line, so a
   * producer that outruns the prompts stays in the pipe apart from the chunk or two the reader
   * holds for later prompts. A read error ends line reading the way EOF does: that prompt and
   * every later one get `None`. So does a line that runs past 64 KiB without a line break
   * (`MAX_PENDING_LINE_BYTES` in `stdin.layer.ts`): the reader stops a chunk or two past that
   * bound and never reaches whatever follows. A non-blocking fd 0 with nothing to read yet is
   * waited on, not treated as a read error.
   */
  readonly readLine: (timeoutMillis: number) => Effect.Effect<Option.Option<string>>;
}

export class Stdin extends Context.Service<Stdin, StdinShape>()("supabase/runtime/Stdin") {}
