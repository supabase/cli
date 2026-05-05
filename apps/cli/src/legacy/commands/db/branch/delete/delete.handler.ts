import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbBranchDeleteFlags } from "./delete.command.ts";

export const legacyDbBranchDelete = Effect.fn("legacy.db.branch.delete")(function* (
  flags: LegacyDbBranchDeleteFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["db", "branch", "delete", flags.branchName];
  yield* proxy.exec(args);
});
