import { Effect } from "effect";
import { GoProxy } from "../../../../command-internal/go-proxy.service.ts";
import type { DbBranchDeleteFlags } from "./delete.command.ts";

export const dbBranchDelete = Effect.fn("db.branch.delete")(function* (flags: DbBranchDeleteFlags) {
  const proxy = yield* GoProxy;
  const args: string[] = ["db", "branch", "delete", flags.branchName];
  yield* proxy.exec(args);
});
