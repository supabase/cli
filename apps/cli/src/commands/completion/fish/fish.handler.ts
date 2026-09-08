import { Effect } from "effect";
import { Output } from "../../../shared/output/output.service.ts";
import { generateCompletionScript } from "../completion-scripts.ts";
import type { CompletionFishFlags } from "./fish.command.ts";

export const completionFish = Effect.fn("completion.fish")(function* (flags: CompletionFishFlags) {
  const output = yield* Output;
  yield* output.raw(generateCompletionScript("fish", { noDescriptions: flags.noDescriptions }));
});
