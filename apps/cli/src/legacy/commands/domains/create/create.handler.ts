import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyDomainsCreateFlags } from "./create.command.ts";

export const legacyDomainsCreate = Effect.fn("legacy.domains.create")(function* (
  flags: LegacyDomainsCreateFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["domains", "create"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  if (Option.isSome(flags.customHostname))
    args.push("--custom-hostname", flags.customHostname.value);
  yield* proxy.exec(args);
});
