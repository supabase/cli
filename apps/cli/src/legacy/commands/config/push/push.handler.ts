import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyConfigPushFlags } from "./push.command.ts";

export const legacyConfigPush = Effect.fn("legacy.config.push")(function* (
  flags: LegacyConfigPushFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["config", "push"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
