import { Effect, Layer, Option } from "effect";

import { LegacyPromptInput } from "../../src/legacy/shared/legacy-prompt-input.service.ts";

/**
 * Test double for {@link LegacyPromptInput}: dispenses the given piped lines one
 * per `nextLine` call, then `None`. With no lines, every call returns `None` —
 * the empty/exhausted-stdin case where `legacyPromptYesNo` falls back to the
 * prompt's default.
 */
export function mockLegacyPromptInput(opts: { readonly pipedLines?: ReadonlyArray<string> } = {}) {
  const lines = opts.pipedLines ?? [];
  let index = 0;
  return Layer.succeed(LegacyPromptInput, {
    nextLine: Effect.sync(() =>
      index < lines.length ? Option.some(lines[index++] ?? "") : Option.none<string>(),
    ),
  });
}
