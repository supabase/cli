import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyMigrationUpFlags } from "./up.command.ts";

export const legacyMigrationUp = Effect.fn("legacy.migration.up")(function* (
  flags: LegacyMigrationUpFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["migration", "up"];
  if (flags.includeAll) args.push("--include-all");
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  yield* proxy.exec(args);
});
