import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbResetFlags } from "./reset.command.ts";

export const legacyDbReset = Effect.fn("legacy.db.reset")(function* (flags: LegacyDbResetFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["db", "reset"];
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  if (flags.noSeed) args.push("--no-seed");
  for (const path of flags.sqlPaths) args.push("--sql-paths", path);
  if (Option.isSome(flags.version)) args.push("--version", flags.version.value);
  if (Option.isSome(flags.last)) args.push("--last", String(flags.last.value));
  yield* proxy.exec(args);
});
