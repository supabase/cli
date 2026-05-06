import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyMigrationListFlags } from "./list.command.ts";

export const legacyMigrationList = Effect.fn("legacy.migration.list")(function* (
  flags: LegacyMigrationListFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["migration", "list"];
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  if (Option.isSome(flags.password)) args.push("--password", flags.password.value);
  yield* proxy.exec(args);
});
