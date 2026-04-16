import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacySslEnforcementGetFlags } from "./get.command.ts";

export const legacySslEnforcementGet = Effect.fn("legacy.ssl-enforcement.get")(function* (
  flags: LegacySslEnforcementGetFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["ssl-enforcement", "get"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
