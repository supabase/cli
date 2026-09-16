import { Effect } from "effect";
import { GoProxy } from "../../../../command-internal/go-proxy.service.ts";
import type { DbBranchCreateFlags } from "./create.command.ts";

export const dbBranchCreate = Effect.fn("db.branch.create")(function* (flags: DbBranchCreateFlags) {
  const proxy = yield* GoProxy;
  const args: string[] = ["db", "branch", "create", flags.branchName];
  yield* proxy.exec(args);
});
