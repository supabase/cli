import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyVanitySubdomainsGetFlags } from "./get.command.ts";

export const legacyVanitySubdomainsGet = Effect.fn("legacy.vanity-subdomains.get")(function* (
  flags: LegacyVanitySubdomainsGetFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["vanity-subdomains", "get"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
