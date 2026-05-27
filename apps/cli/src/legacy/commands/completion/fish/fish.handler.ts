import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyCompletionFishFlags } from "./fish.command.ts";

export const legacyCompletionFish = Effect.fn("legacy.completion.fish")(function* (
  _flags: LegacyCompletionFishFlags,
) {
  const proxy = yield* LegacyGoProxy;
  yield* proxy.exec(["completion", "fish"]);
});
