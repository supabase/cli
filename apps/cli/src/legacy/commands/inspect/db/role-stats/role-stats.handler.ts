import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyInspectDbRoleStatsFlags } from "./role-stats.command.ts";

export const legacyInspectDbRoleStats = Effect.fn("legacy.inspect.db.role-stats")(function* (
  flags: LegacyInspectDbRoleStatsFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["inspect", "db", "role-stats"];
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  yield* proxy.exec(args);
});
