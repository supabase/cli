import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacySsoShowFlags } from "./show.command.ts";

export const legacySsoShow = Effect.fn("legacy.sso.show")(function* (flags: LegacySsoShowFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["sso", "show"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  if (flags.metadata) args.push("--metadata");
  args.push(flags.providerId);
  yield* proxy.exec(args);
});
