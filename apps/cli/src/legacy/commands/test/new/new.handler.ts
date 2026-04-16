import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyTestNewFlags } from "./new.command.ts";

export const legacyTestNew = Effect.fn("legacy.test.new")(function* (flags: LegacyTestNewFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["test", "new", flags.name];
  if (Option.isSome(flags.template)) args.push("--template", flags.template.value);
  yield* proxy.exec(args);
});
