import { Effect } from "effect";
import { GoProxy } from "../../../../command-internal/go-proxy.service.ts";
import type { DbBranchListFlags } from "./list.command.ts";

export const dbBranchList = Effect.fn("db.branch.list")(function* (_flags: DbBranchListFlags) {
  const proxy = yield* GoProxy;
  yield* proxy.exec(["db", "branch", "list"]);
});
