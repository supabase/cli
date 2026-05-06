import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbTestFlags } from "./test.command.ts";

export const legacyDbTest = Effect.fn("legacy.db.test")(function* (flags: LegacyDbTestFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["db", "test"];
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  for (const p of flags.paths) {
    args.push(String(p));
  }
  yield* proxy.exec(args);
});
