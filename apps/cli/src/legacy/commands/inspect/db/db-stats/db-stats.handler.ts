import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyInspectDbDbStatsFlags } from "./db-stats.command.ts";

export const legacyInspectDbDbStats = Effect.fn("legacy.inspect.db.db-stats")(function* (
  flags: LegacyInspectDbDbStatsFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["inspect", "db", "db-stats"];
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  yield* proxy.exec(args);
});
