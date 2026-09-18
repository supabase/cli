import { Effect } from "effect";
import { Output } from "../../../shared/output/output.service.ts";
import { generateCompletionScript } from "../completion-scripts.ts";
import type { CompletionPowershellFlags } from "./powershell.command.ts";

export const completionPowershell = Effect.fn("completion.powershell")(function* (
  flags: CompletionPowershellFlags,
) {
  const output = yield* Output;
  yield* output.raw(
    generateCompletionScript("powershell", { noDescriptions: flags.noDescriptions }),
  );
});
