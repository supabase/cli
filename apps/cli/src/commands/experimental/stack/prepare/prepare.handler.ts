import { Cause, Effect, Exit, Option } from "effect";
import type {
  PrepareStackResult,
  ServiceInstanceId,
  StackRuntimePreference,
} from "@supabase/stack/effect";
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
import { loadStackConfig } from "../../../../command-internal/stack-config.ts";
import type { StackPrepareFlags } from "./prepare.command.ts";
import { StackCommandPrepareError, stackPrepareError } from "./prepare.errors.ts";

const payload = (id: string, result: PrepareStackResult) => ({
  id,
  instances: result.instances,
});
const render = (id: string, result: PrepareStackResult) => {
  const lines = [`Stack ${id} prepared.`];
  if (result.instances.length > 0) {
    lines.push("Instances:");
    for (const instance of result.instances)
      lines.push(`  ${instance.id} ${instance.service} (${instance.artifacts.length} artifacts)`);
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
    const existing =
      target.id === undefined
        ? yield* api
            .findStack({
              projectRoot: target.projectRoot,
              ...(target.name === undefined ? {} : { name: target.name }),
            })
            .pipe(Effect.mapError(stackPrepareError))
        : Option.some({ id: target.id });
    const stack = Option.isSome(existing)
      ? yield* api.openStack(existing.value.id).pipe(Effect.mapError(stackPrepareError))
      : yield* api
          .createStack({
            projectRoot: target.projectRoot,
            ...(target.name === undefined ? {} : { name: target.name }),
            ...(runtime === undefined ? {} : { runtime }),
            initialConfig: config,
          })
          .pipe(Effect.mapError(stackPrepareError));
    const descriptors = yield* stack.services.list.pipe(Effect.mapError(stackPrepareError));
    const selectedIds: ReadonlyArray<ServiceInstanceId> =
      flags.capability.length === 0
        ? descriptors.filter((descriptor) => descriptor.enabled).map((descriptor) => descriptor.id)
        : descriptors
            .filter((descriptor) => flags.capability.includes(descriptor.service))
            .map((descriptor) => descriptor.id);
    const task = yield* output.task("Preparing local Supabase stack...");
    const result = yield* stack
      .prepare(selectedIds.length === 0 ? {} : { services: selectedIds })
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
