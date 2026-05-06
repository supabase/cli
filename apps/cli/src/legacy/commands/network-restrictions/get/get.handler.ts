import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyNetworkRestrictionsGetFlags } from "./get.command.ts";

export const legacyNetworkRestrictionsGet = Effect.fn("legacy.network-restrictions.get")(function* (
  flags: LegacyNetworkRestrictionsGetFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["network-restrictions", "get"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
