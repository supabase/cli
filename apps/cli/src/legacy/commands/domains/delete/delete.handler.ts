import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDomainsDeleteFlags } from "./delete.command.ts";

export const legacyDomainsDelete = Effect.fn("legacy.domains.delete")(function* (
  flags: LegacyDomainsDeleteFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["domains", "delete"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
