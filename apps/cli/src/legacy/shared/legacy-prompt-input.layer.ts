import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Ref } from "effect";

import { stdinLayer } from "../../shared/runtime/stdin.layer.ts";
import { Stdin } from "../../shared/runtime/stdin.service.ts";
import { ttyLayer } from "../../shared/runtime/tty.layer.ts";
import { LegacyPromptInput } from "./legacy-prompt-input.service.ts";

interface LineBuffer {
  readonly lines: ReadonlyArray<string>;
  readonly index: number;
}

/**
 * Builds {@link LegacyPromptInput} over the {@link Stdin} service. Piped stdin is
 * read once on the first `nextLine` and split into lines (each trimmed, matching
 * Go's `strings.TrimSpace(scanner.Text())` at `console.go:51`); subsequent calls
 * walk the buffer one line at a time, returning `None` past the end.
 */
const legacyPromptInputLayer = Layer.effect(
  LegacyPromptInput,
  Effect.gen(function* () {
    const stdin = yield* Stdin;
    const stateRef = yield* Ref.make<LineBuffer | undefined>(undefined);
    const nextLine = Effect.gen(function* () {
      let state = yield* Ref.get(stateRef);
      if (state === undefined) {
        const piped = yield* stdin.readPipedText;
        const lines = Option.isSome(piped)
          ? piped.value.split("\n").map((line) => line.trim())
          : [];
        state = { lines, index: 0 };
      }
      if (state.index >= state.lines.length) {
        yield* Ref.set(stateRef, state);
        return Option.none<string>();
      }
      const line = state.lines[state.index];
      yield* Ref.set(stateRef, { lines: state.lines, index: state.index + 1 });
      return line === undefined ? Option.none<string>() : Option.some(line);
    });
    return { nextLine };
  }),
);

/**
 * Self-contained {@link LegacyPromptInput} provider: bundles the `Stdin`, `Tty`,
 * and platform (`Stdio`) dependencies so a command only needs to merge this one
 * layer. Provided explicitly per command (not via sibling leakage in a
 * `Layer.mergeAll`); see `encryption/update-root-key/update-root-key.command.ts`.
 */
export const legacyPromptInputRuntimeLayer = legacyPromptInputLayer.pipe(
  Layer.provide(stdinLayer.pipe(Layer.provide(ttyLayer), Layer.provide(BunServices.layer))),
);
