import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyCompletionPowershellFlags } from "./powershell.command.ts";

export const legacyCompletionPowershell = Effect.fn("legacy.completion.powershell")(function* (
  flags: LegacyCompletionPowershellFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["completion", "powershell"];
  if (flags.noDescriptions) args.push("--no-descriptions");
  yield* proxy.exec(args);
});
