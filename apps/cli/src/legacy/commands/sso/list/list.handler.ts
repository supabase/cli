import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacySsoListFlags } from "./list.command.ts";

export const legacySsoList = Effect.fn("legacy.sso.list")(function* (flags: LegacySsoListFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["sso", "list"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
