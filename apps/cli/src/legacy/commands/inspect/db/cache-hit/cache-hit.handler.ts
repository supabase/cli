import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyInspectDbCacheHitFlags } from "./cache-hit.command.ts";

export const legacyInspectDbCacheHit = Effect.fn("legacy.inspect.db.cache-hit")(function* (
  flags: LegacyInspectDbCacheHitFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["inspect", "db", "cache-hit"];
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  yield* proxy.exec(args);
});
