import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyMigrationDownFlags } from "./down.command.ts";

export const legacyMigrationDown = Effect.fn("legacy.migration.down")(function* (
  flags: LegacyMigrationDownFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["migration", "down"];
  if (Option.isSome(flags.last)) args.push("--last", String(flags.last.value));
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  yield* proxy.exec(args);
});
