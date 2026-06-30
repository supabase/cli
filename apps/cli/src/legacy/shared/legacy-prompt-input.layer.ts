import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Pull, Ref, Stdio, Stream } from "effect";

import { LegacyPromptInput } from "./legacy-prompt-input.service.ts";

// Go's non-TTY `ReadLine` timeout (`apps/cli-go/internal/utils/console.go:36`): a
// non-terminal read that yields no line within this window falls back to the
// prompt's default instead of blocking on EOF.
const NON_TTY_TIMEOUT = "100 millis";

/**
 * Builds {@link LegacyPromptInput} over the platform stdin stream. Reads piped
 * stdin **lazily, one line at a time** — mirroring Go's persistent `bufio.Scanner`
 * with its non-TTY timeout (`console.go:31-61`):
 *  - `Stream.splitLines` preserves leading/interior blank lines (Go scans then
 *    trims one line at a time), so answers to successive prompts stay aligned;
 *  - `Stream.toPull` + `Effect.timeoutOption` return as soon as a line is
 *    available and never wait for EOF, so a pipe that stays open (e.g.
 *    `yes y | …`) answers the first prompt instead of hanging;
 *  - each line is trimmed to match Go's `strings.TrimSpace(scanner.Text())`.
 */
const legacyPromptInputLayer = Layer.effect(
  LegacyPromptInput,
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const lines = stdio.stdin.pipe(Stream.decodeText(), Stream.splitLines);
    const pull = yield* Stream.toPull(lines);
    // Leftover lines from the last pulled chunk (a single pull may yield several).
    const bufferRef = yield* Ref.make<ReadonlyArray<string>>([]);
    // Pull the next chunk of lines: success -> Some(chunk); EOF or a read error
    // -> None. The timeout is applied by the caller, per prompt.
    const readChunk = Pull.matchEffect(pull, {
      onSuccess: (chunk) => Effect.succeed(Option.some(chunk)),
      onFailure: () => Effect.succeedNone,
      onDone: () => Effect.succeedNone,
    });
    const nextLine = Effect.gen(function* () {
      const buffered = yield* Ref.get(bufferRef);
      if (buffered.length > 0) {
        yield* Ref.set(bufferRef, buffered.slice(1));
        return Option.some((buffered[0] ?? "").trim());
      }
      // Bounded by Go's non-TTY timeout so an open pipe without a newline (e.g.
      // `yes y | …`) doesn't block on EOF. Outer `None` = timed out; inner `None`
      // = EOF / read error; either way the prompt takes its default.
      const pulled = yield* readChunk.pipe(Effect.timeoutOption(NON_TTY_TIMEOUT));
      if (Option.isNone(pulled) || Option.isNone(pulled.value)) {
        return Option.none<string>();
      }
      const chunk = pulled.value.value;
      yield* Ref.set(bufferRef, chunk.slice(1));
      return Option.some((chunk[0] ?? "").trim());
    });
    return { nextLine };
  }),
);

/**
 * Self-contained {@link LegacyPromptInput} provider: bundles the platform
 * (`Stdio`) dependency so a command only needs to merge this one layer. Provided
 * explicitly per command (not via sibling leakage in a `Layer.mergeAll`); see
 * `encryption/update-root-key/update-root-key.command.ts`.
 */
export const legacyPromptInputRuntimeLayer = legacyPromptInputLayer.pipe(
  Layer.provide(BunServices.layer),
);
