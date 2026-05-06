import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyInspectDbIndexUsageFlags } from "./index-usage.command.ts";

export const legacyInspectDbIndexUsage = Effect.fn("legacy.inspect.db.index-usage")(function* (
  flags: LegacyInspectDbIndexUsageFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["inspect", "db", "index-usage"];
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  yield* proxy.exec(args);
});
