import { Effect } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { legacyGenerateCompletionScript } from "../legacy-completion-scripts.ts";
import type { LegacyCompletionBashFlags } from "./bash.command.ts";

export const legacyCompletionBash = Effect.fn("legacy.completion.bash")(function* (
  flags: LegacyCompletionBashFlags,
) {
  const output = yield* Output;
  yield* output.raw(
    legacyGenerateCompletionScript("bash", { noDescriptions: flags.noDescriptions }),
  );
});
