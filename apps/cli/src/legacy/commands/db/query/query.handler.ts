import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbQueryFlags } from "./query.command.ts";

export const legacyDbQuery = Effect.fn("legacy.db.query")(function* (flags: LegacyDbQueryFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["db", "query"];
  if (Option.isSome(flags.sql)) args.push(flags.sql.value);
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  if (Option.isSome(flags.file)) args.push("--file", flags.file.value);
  if (Option.isSome(flags.output)) args.push("--output", flags.output.value);
  yield* proxy.exec(args);
});
