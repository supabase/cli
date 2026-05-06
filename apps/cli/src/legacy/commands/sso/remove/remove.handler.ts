import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacySsoRemoveFlags } from "./remove.command.ts";

export const legacySsoRemove = Effect.fn("legacy.sso.remove")(function* (
  flags: LegacySsoRemoveFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["sso", "remove"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  args.push(flags.providerId);
  yield* proxy.exec(args);
});
