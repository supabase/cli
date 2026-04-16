import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyBranchesUnpauseFlags } from "./unpause.command.ts";

export const legacyBranchesUnpause = Effect.fn("legacy.branches.unpause")(function* (
  flags: LegacyBranchesUnpauseFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["branches", "unpause"];
  if (Option.isSome(flags.name)) args.push(flags.name.value);
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
