import { Effect } from "effect";
import { Output } from "../../../shared/output/output.service.ts";
import { generateCompletionScript } from "../completion-scripts.ts";
import type { CompletionBashFlags } from "./bash.command.ts";

export const completionBash = Effect.fn("completion.bash")(function* (flags: CompletionBashFlags) {
  const output = yield* Output;
  yield* output.raw(generateCompletionScript("bash", { noDescriptions: flags.noDescriptions }));
});
