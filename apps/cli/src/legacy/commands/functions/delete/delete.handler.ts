import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyFunctionsDeleteFlags } from "./delete.command.ts";

export const legacyFunctionsDelete = Effect.fn("legacy.functions.delete")(function* (
  flags: LegacyFunctionsDeleteFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["functions", "delete", flags.functionName];
  if (Option.isSome(flags.projectRef)) args.push("--project-ref", flags.projectRef.value);
  yield* proxy.exec(args);
});
