import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyCompletionPowershellFlags } from "./powershell.command.ts";

export const legacyCompletionPowershell = Effect.fn("legacy.completion.powershell")(function* (
  _flags: LegacyCompletionPowershellFlags,
) {
  const proxy = yield* LegacyGoProxy;
  yield* proxy.exec(["completion", "powershell"]);
});
