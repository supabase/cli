import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbBranchCreateFlags } from "./create.command.ts";

export const legacyDbBranchCreate = Effect.fn("legacy.db.branch.create")(function* (
  flags: LegacyDbBranchCreateFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["db", "branch", "create", flags.branchName];
  yield* proxy.exec(args);
});
