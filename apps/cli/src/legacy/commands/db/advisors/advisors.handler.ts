import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbAdvisorsFlags } from "./advisors.command.ts";

export const legacyDbAdvisors = Effect.fn("legacy.db.advisors")(function* (
  flags: LegacyDbAdvisorsFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["db", "advisors"];
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  if (Option.isSome(flags.type)) args.push("--type", flags.type.value);
  if (Option.isSome(flags.level)) args.push("--level", flags.level.value);
  if (Option.isSome(flags.failOn)) args.push("--fail-on", flags.failOn.value);
  yield* proxy.exec(args);
});
