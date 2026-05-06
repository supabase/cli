import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyNetworkBansRemoveFlags } from "./remove.command.ts";

export const legacyNetworkBansRemove = Effect.fn("legacy.network-bans.remove")(function* (
  flags: LegacyNetworkBansRemoveFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["network-bans", "remove"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  for (const ip of flags.dbUnbanIp) {
    args.push("--db-unban-ip", ip);
  }
  yield* proxy.exec(args);
});
