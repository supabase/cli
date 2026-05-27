import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyCompletionZshFlags } from "./zsh.command.ts";

export const legacyCompletionZsh = Effect.fn("legacy.completion.zsh")(function* (
  _flags: LegacyCompletionZshFlags,
) {
  const proxy = yield* LegacyGoProxy;
  yield* proxy.exec(["completion", "zsh"]);
});
