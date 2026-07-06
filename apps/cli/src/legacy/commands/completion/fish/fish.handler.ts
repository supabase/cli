import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyCompletionFishFlags } from "./fish.command.ts";

export const legacyCompletionFish = Effect.fn("legacy.completion.fish")(function* (
  flags: LegacyCompletionFishFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["completion", "fish"];
  if (flags.noDescriptions) args.push("--no-descriptions");
  yield* proxy.exec(args);
});
