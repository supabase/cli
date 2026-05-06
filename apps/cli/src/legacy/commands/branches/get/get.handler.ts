import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyBranchesGetFlags } from "./get.command.ts";

export const legacyBranchesGet = Effect.fn("legacy.branches.get")(function* (
  flags: LegacyBranchesGetFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["branches", "get"];
  if (Option.isSome(flags.name)) args.push(flags.name.value);
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
