import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyBranchesDisableFlags } from "./disable.command.ts";

export const legacyBranchesDisable = Effect.fn("legacy.branches.disable")(function* (
  flags: LegacyBranchesDisableFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["branches", "disable"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
