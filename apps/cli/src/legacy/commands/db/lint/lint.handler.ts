import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDbLintFlags } from "./lint.command.ts";

export const legacyDbLint = Effect.fn("legacy.db.lint")(function* (flags: LegacyDbLintFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["db", "lint"];
  if (Option.isSome(flags.dbUrl)) args.push("--db-url", flags.dbUrl.value);
  if (flags.linked) args.push("--linked");
  if (flags.local) args.push("--local");
  for (const s of flags.schema) {
    args.push("--schema", s);
  }
  if (Option.isSome(flags.level)) args.push("--level", flags.level.value);
  if (Option.isSome(flags.failOn)) args.push("--fail-on", flags.failOn.value);
  yield* proxy.exec(args);
});
