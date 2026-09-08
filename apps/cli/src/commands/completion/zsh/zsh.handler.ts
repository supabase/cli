import { Effect } from "effect";
import { Output } from "../../../shared/output/output.service.ts";
import { generateCompletionScript } from "../completion-scripts.ts";
import type { CompletionZshFlags } from "./zsh.command.ts";

export const completionZsh = Effect.fn("completion.zsh")(function* (flags: CompletionZshFlags) {
  const output = yield* Output;
  yield* output.raw(generateCompletionScript("zsh", { noDescriptions: flags.noDescriptions }));
});
