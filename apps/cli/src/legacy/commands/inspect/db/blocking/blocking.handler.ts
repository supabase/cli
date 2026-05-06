import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyInspectDbBlockingFlags } from "./blocking.command.ts";

export const legacyInspectDbBlocking = Effect.fn("legacy.inspect.db.blocking")(function* (
  flags: LegacyInspectDbBlockingFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["inspect", "db", "blocking"];
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  yield* proxy.exec(args);
});
