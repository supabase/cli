import { Effect } from "effect";
import type { FunctionsDevFlags } from "./dev.command.ts";
import { runFunctionsDevRuntime } from "./functions-dev-runtime.ts";

export const functionsDev = Effect.fnUntraced(function* (flags: FunctionsDevFlags) {
  return yield* runFunctionsDevRuntime({
    stack: flags.stack,
    envFile: flags.envFile,
    noVerifyJwt: flags.noVerifyJwt,
  });
});
