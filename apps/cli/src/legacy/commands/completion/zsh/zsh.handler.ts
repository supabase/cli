import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyCompletionZshFlags } from "./zsh.command.ts";

export const legacyCompletionZsh = Effect.fn("legacy.completion.zsh")(function* (
  flags: LegacyCompletionZshFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["completion", "zsh"];
  if (flags.noDescriptions) args.push("--no-descriptions");
  yield* proxy.exec(args);
});
