import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyMigrationSquashFlags } from "./squash.command.ts";

export const legacyMigrationSquash = Effect.fn("legacy.migration.squash")(function* (
  flags: LegacyMigrationSquashFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["migration", "squash"];
  if (Option.isSome(flags.version)) args.push("--version", flags.version.value);
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  if (Option.isSome(flags.password)) args.push("--password", flags.password.value);
  yield* proxy.exec(args);
});
