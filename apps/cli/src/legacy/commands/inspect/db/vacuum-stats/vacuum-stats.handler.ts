import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyInspectDbVacuumStatsFlags } from "./vacuum-stats.command.ts";

export const legacyInspectDbVacuumStats = Effect.fn("legacy.inspect.db.vacuum-stats")(function* (
  flags: LegacyInspectDbVacuumStatsFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["inspect", "db", "vacuum-stats"];
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  yield* proxy.exec(args);
});
