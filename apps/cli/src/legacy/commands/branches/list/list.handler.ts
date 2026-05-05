import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyBranchesListFlags } from "./list.command.ts";

export const legacyBranchesList = Effect.fn("legacy.branches.list")(function* (
  flags: LegacyBranchesListFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["branches", "list"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
