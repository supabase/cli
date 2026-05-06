import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacySnippetsListFlags } from "./list.command.ts";

export const legacySnippetsList = Effect.fn("legacy.snippets.list")(function* (
  flags: LegacySnippetsListFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["snippets", "list"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
