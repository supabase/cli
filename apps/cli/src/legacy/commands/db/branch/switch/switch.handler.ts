import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbBranchSwitchFlags } from "./switch.command.ts";

export const legacyDbBranchSwitch = Effect.fn("legacy.db.branch.switch")(function* (
  flags: LegacyDbBranchSwitchFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["db", "branch", "switch", flags.branchName];
  yield* proxy.exec(args);
});
