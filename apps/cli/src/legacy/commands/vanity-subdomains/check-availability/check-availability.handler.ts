import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyVanitySubdomainsCheckAvailabilityFlags } from "./check-availability.command.ts";

export const legacyVanitySubdomainsCheckAvailability = Effect.fn(
  "legacy.vanity-subdomains.check-availability",
)(function* (flags: LegacyVanitySubdomainsCheckAvailabilityFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["vanity-subdomains", "check-availability"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  args.push("--desired-subdomain", flags.desiredSubdomain);
  yield* proxy.exec(args);
});
