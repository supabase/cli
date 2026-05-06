import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDomainsActivateFlags } from "./activate.command.ts";

export const legacyDomainsActivate = Effect.fn("legacy.domains.activate")(function* (
  flags: LegacyDomainsActivateFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["domains", "activate"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
