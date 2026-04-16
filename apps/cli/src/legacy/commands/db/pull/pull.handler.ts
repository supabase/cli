import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbPullFlags } from "./pull.command.ts";

export const legacyDbPull = Effect.fn("legacy.db.pull")(function* (flags: LegacyDbPullFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["db", "pull"];
  if (Option.isSome(flags.name)) args.push(flags.name.value);
  if (flags.usePgDelta) args.push("--use-pg-delta");
  for (const s of flags.schema) {
    args.push("--schema", s);
  }
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  if (Option.isSome(flags.password)) args.push("--password", flags.password.value);
  yield* proxy.exec(args);
});
