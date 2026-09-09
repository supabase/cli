import { Effect } from "effect";
import { GoProxy } from "../../../../command-internal/go-proxy.service.ts";
import type { DbBranchSwitchFlags } from "./switch.command.ts";

export const dbBranchSwitch = Effect.fn("db.branch.switch")(function* (flags: DbBranchSwitchFlags) {
  const proxy = yield* GoProxy;
  const args: string[] = ["db", "branch", "switch", flags.branchName];
  yield* proxy.exec(args);
});
