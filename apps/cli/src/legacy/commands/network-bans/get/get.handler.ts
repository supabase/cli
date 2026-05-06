import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyNetworkBansGetFlags } from "./get.command.ts";

export const legacyNetworkBansGet = Effect.fn("legacy.network-bans.get")(function* (
  flags: LegacyNetworkBansGetFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["network-bans", "get"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
