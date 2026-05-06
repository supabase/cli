import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyVanitySubdomainsActivateFlags } from "./activate.command.ts";

export const legacyVanitySubdomainsActivate = Effect.fn("legacy.vanity-subdomains.activate")(
  function* (flags: LegacyVanitySubdomainsActivateFlags) {
    const proxy = yield* LegacyGoProxy;
    const args: string[] = ["vanity-subdomains", "activate"];
    if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
    args.push("--desired-subdomain", flags.desiredSubdomain);
    yield* proxy.exec(args);
  },
);
