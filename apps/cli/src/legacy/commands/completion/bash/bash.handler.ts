import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyCompletionBashFlags } from "./bash.command.ts";

export const legacyCompletionBash = Effect.fn("legacy.completion.bash")(function* (
  flags: LegacyCompletionBashFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["completion", "bash"];
  if (flags.noDescriptions) args.push("--no-descriptions");
  yield* proxy.exec(args);
});
