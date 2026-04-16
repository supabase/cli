import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyBranchesDeleteFlags } from "./delete.command.ts";

export const legacyBranchesDelete = Effect.fn("legacy.branches.delete")(function* (
  flags: LegacyBranchesDeleteFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["branches", "delete"];
  if (Option.isSome(flags.name)) args.push(flags.name.value);
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
