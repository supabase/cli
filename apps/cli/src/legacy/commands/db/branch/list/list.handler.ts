import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbBranchListFlags } from "./list.command.ts";

export const legacyDbBranchList = Effect.fn("legacy.db.branch.list")(function* (
  _flags: LegacyDbBranchListFlags,
) {
  const proxy = yield* LegacyGoProxy;
  yield* proxy.exec(["db", "branch", "list"]);
});
