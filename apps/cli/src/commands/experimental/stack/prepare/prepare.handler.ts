import { Cause, Effect, Exit, Option } from "effect";
import type { PrepareStackResult, StackRuntimePreference } from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  StackApi,
  StackTargetError,
  rejectStackOutput,
  StackTargetResolver,
  validateStackTarget,
} from "../stack.shared.ts";
import { loadStackConfig } from "../stack-config.ts";
import type { StackPrepareFlags } from "./prepare.command.ts";
import { StackCommandPrepareError, stackPrepareError } from "./prepare.errors.ts";

const payload = (id: string, result: PrepareStackResult) => ({
  id,
  capabilities: result.capabilities,
});
const render = (id: string, result: PrepareStackResult) => {
  const lines = [`Stack ${id} prepared.`];
  if (result.capabilities.length > 0) {
    lines.push("Capabilities:");
    for (const capability of result.capabilities)
      lines.push(`  ${capability.capability} ${capability.version} (${capability.outcome})`);
  }
  return `${lines.join("\n")}\n`;
};

const mapTargetError = (error: StackTargetError) =>
  new StackCommandPrepareError({
    reason: error.reason,
    message: error.message,
    ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
    cause: error,
  });

export const stackPrepare = Effect.fn("experimental.stack.prepare")(function* (
  flags: StackPrepareFlags,
) {
  const telemetryState = yield* TelemetryState;
  const body = Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const resolver = yield* StackTargetResolver;
    const api = yield* StackApi;
    const outputFlag = yield* Effect.serviceOption(OutputFlag);
    yield* rejectStackOutput(outputFlag).pipe(Effect.mapError(mapTargetError));
    yield* validateStackTarget({
      stack: Option.getOrUndefined(flags.stack),
      stackId: Option.getOrUndefined(flags.stackId),
    }).pipe(Effect.mapError(mapTargetError));
    const target = yield* resolver
      .resolve({
        projectRoot: settings.workdir,
        ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
        ...(Option.isSome(flags.stackId) ? { id: flags.stackId.value } : {}),
        runtime: flags.runtime,
      })
      .pipe(Effect.mapError(mapTargetError));
    const config = yield* loadStackConfig(target.projectRoot).pipe(
      Effect.mapError(
        (error) =>
          new StackCommandPrepareError({
            reason: "invalid-config",
            message: error.message,
            cause: error,
          }),
      ),
    );
    const runtime: StackRuntimePreference | undefined = target.runtime;
    const stack =
      target.id !== undefined
        ? yield* api.openStack(target.id).pipe(Effect.mapError(stackPrepareError))
        : yield* api
            .createStack({
              projectRoot: target.projectRoot,
              ...(target.name === undefined ? {} : { name: target.name }),
              ...(runtime === undefined ? {} : { runtime }),
            })
            .pipe(Effect.mapError(stackPrepareError));
    const task = yield* output.task("Preparing local Supabase stack...");
    const result = yield* stack
      .prepare({
        config,
        ...(flags.capability.length === 0 ? {} : { capabilities: flags.capability }),
      })
      .pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? task.clear()
            : Option.match(Cause.findErrorOption(exit.cause), {
                onNone: () => (Cause.hasInterruptsOnly(exit.cause) ? task.cancel() : task.fail()),
                onSome: (error) => task.fail(error.message),
              }),
        ),
        Effect.mapError(stackPrepareError),
      );
    if (output.format === "text") yield* output.raw(render(stack.id, result));
    else yield* output.success("", payload(stack.id, result));
    return result;
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
