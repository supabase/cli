import { Effect } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyFunctionsNewFlags } from "./new.command.ts";

export const legacyFunctionsNew = Effect.fn("legacy.functions.new")(function* (
  flags: LegacyFunctionsNewFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["functions", "new", flags.functionName];
  yield* proxy.exec(args);
});
