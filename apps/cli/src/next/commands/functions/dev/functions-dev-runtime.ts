import { Effect, Option } from "effect";
import { CliProjectHome } from "../../../config/cli-project-home.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import type { FunctionsDevFlags } from "./dev.command.ts";
import { serveManagedFunctions } from "../../../../shared/functions/managed-functions-runtime.ts";

export const runFunctionsDevRuntime = Effect.fnUntraced(function* (flags: FunctionsDevFlags) {
  const runtimeInfo = yield* RuntimeInfo;
  return yield* serveManagedFunctions({
    projectRoot: (yield* CliProjectHome).projectRoot,
    stackName: flags.stack,
    cwd: runtimeInfo.cwd,
    envFile: Option.getOrUndefined(flags.envFile),
    noVerifyJwt: flags.noVerifyJwt,
    importMap: Option.getOrUndefined(flags.importMap),
    inspect: flags.inspect,
    inspectMode: Option.getOrUndefined(flags.inspectMode),
    inspectMain: flags.inspectMain,
  });
});
