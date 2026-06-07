import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyFunctionsListFlags } from "./list.command.ts";

export const legacyFunctionsList = Effect.fn("legacy.functions.list")(function* (
  flags: LegacyFunctionsListFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["functions", "list"];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
