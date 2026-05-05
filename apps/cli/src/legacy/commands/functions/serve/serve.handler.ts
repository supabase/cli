import { Effect, Option } from "effect";
import { LegacyGoProxy } from "../../../../shared/legacy/go-proxy.service.ts";
import type { LegacyFunctionsServeFlags } from "./serve.command.ts";

export const legacyFunctionsServe = Effect.fn("legacy.functions.serve")(function* (
  flags: LegacyFunctionsServeFlags,
) {
  const proxy = yield* LegacyGoProxy;
  const args: string[] = ["functions", "serve"];
  if (flags.noVerifyJwt) args.push("--no-verify-jwt");
  if (Option.isSome(flags.envFile)) args.push("--env-file", flags.envFile.value);
  if (Option.isSome(flags.importMap)) args.push("--import-map", flags.importMap.value);
  if (flags.inspect) args.push("--inspect");
  if (Option.isSome(flags.inspectMode)) args.push("--inspect-mode", flags.inspectMode.value);
  if (flags.inspectMain) args.push("--inspect-main");
  yield* proxy.exec(args);
});
