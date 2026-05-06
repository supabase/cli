import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDomainsGetFlags } from "./get.command.ts";

export const legacyDomainsGet = Effect.fn("legacy.domains.get")(function* (
  flags: LegacyDomainsGetFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["domains", "get"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
