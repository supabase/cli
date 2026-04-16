import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyBranchesPauseFlags } from "./pause.command.ts";

export const legacyBranchesPause = Effect.fn("legacy.branches.pause")(function* (
  flags: LegacyBranchesPauseFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["branches", "pause"];
  if (Option.isSome(flags.name)) args.push(flags.name.value);
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
