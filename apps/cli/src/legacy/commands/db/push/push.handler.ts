import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbPushFlags } from "./push.command.ts";

export const legacyDbPush = Effect.fn("legacy.db.push")(function* (flags: LegacyDbPushFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["db", "push"];
  if (flags.includeAll) args.push("--include-all");
  if (flags.includeRoles) args.push("--include-roles");
  if (flags.includeSeed) args.push("--include-seed");
  if (flags.dryRun) args.push("--dry-run");
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  if (Option.isSome(flags.password)) args.push("--password", flags.password.value);
  yield* proxy.exec(args);
});
