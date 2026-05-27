import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyCompletionBashFlags } from "./bash.command.ts";

export const legacyCompletionBash = Effect.fn("legacy.completion.bash")(function* (
  _flags: LegacyCompletionBashFlags,
) {
  const proxy = yield* LegacyGoProxy;
  yield* proxy.exec(["completion", "bash"]);
});
