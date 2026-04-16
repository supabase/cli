import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyNetworkRestrictionsUpdateFlags } from "./update.command.ts";

export const legacyNetworkRestrictionsUpdate = Effect.fn("legacy.network-restrictions.update")(
  function* (flags: LegacyNetworkRestrictionsUpdateFlags) {
    const proxy = yield* LegacyGoProxy;
    const args: string[] = ["network-restrictions", "update"];
    if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
    for (const cidr of flags.dbAllowCidr) {
      args.push("--db-allow-cidr", cidr);
    }
    if (flags.bypassCidrChecks) args.push("--bypass-cidr-checks");
    if (flags.append) args.push("--append");
    yield* proxy.exec(args);
  },
);
