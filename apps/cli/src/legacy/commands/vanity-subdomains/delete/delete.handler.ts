import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyVanitySubdomainsDeleteFlags } from "./delete.command.ts";

export const legacyVanitySubdomainsDelete = Effect.fn("legacy.vanity-subdomains.delete")(function* (
  flags: LegacyVanitySubdomainsDeleteFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["vanity-subdomains", "delete"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
