import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacySnippetsDownloadFlags } from "./download.command.ts";

export const legacySnippetsDownload = Effect.fn("legacy.snippets.download")(function* (
  flags: LegacySnippetsDownloadFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["snippets", "download", flags.snippetId];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
