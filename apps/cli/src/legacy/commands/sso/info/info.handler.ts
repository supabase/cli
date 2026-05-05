import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacySsoInfoFlags } from "./info.command.ts";

export const legacySsoInfo = Effect.fn("legacy.sso.info")(function* (flags: LegacySsoInfoFlags) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["sso", "info"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
