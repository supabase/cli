import { Cause, Effect, Exit, Option, Path } from "effect";
import type { StackError } from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  StackApi,
  StackTargetResolver,
  rejectStackOutput,
  validateStackTarget,
} from "../stack.shared.ts";
import { StackCommandRestartError } from "./restart.errors.ts";
import type { StackRestartFlags } from "./restart.command.ts";

const runtimeError = (cause: StackError) =>
  new StackCommandRestartError({
    reason: "unknown",
    message: cause.message,
    ...(cause.outcomes === undefined
      ? {}
      : {
          detail: cause.outcomes
            .filter((outcome) => !outcome.succeeded)
            .map((outcome) => `${outcome.id}: ${outcome.error ?? "failed"}`)
            .join("\n"),
        }),
    cause,
  });

export const stackRestart = Effect.fn("experimental.stack.restart")(function* (
  flags: StackRestartFlags,
) {
  const telemetry = yield* TelemetryState;
  return yield* Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const path = yield* Path.Path;
    const api = yield* StackApi;
    const resolver = yield* StackTargetResolver;
    const mapTargetError = (cause: {
      readonly reason: "flags" | "invalid-config";
      readonly message: string;
      readonly suggestion?: string;
    }) =>
      new StackCommandRestartError({
        reason: cause.reason,
        message: cause.message,
        ...(cause.suggestion === undefined ? {} : { suggestion: cause.suggestion }),
        cause,
      });
    yield* rejectStackOutput(yield* Effect.serviceOption(OutputFlag)).pipe(
      Effect.mapError(mapTargetError),
    );
    yield* validateStackTarget({
      stack: Option.getOrUndefined(flags.stack),
      stackId: Option.getOrUndefined(flags.stackId),
    }).pipe(Effect.mapError(mapTargetError));
    const target = yield* resolver
      .resolve({
        projectRoot: settings.workdir,
        runtime: "auto",
        ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
        ...(Option.isSome(flags.stackId) ? { id: flags.stackId.value } : {}),
      })
      .pipe(Effect.mapError(mapTargetError));
    if (target.id === undefined)
      return yield* new StackCommandRestartError({
        reason: "not-found",
        message: "No managed stack exists for the selected project.",
        suggestion: "Run supabase stack start first.",
      });
    const stack = yield* api
      .open({
        id: target.id,
        stateRoot: path.join(settings.supabaseHome, "stacks"),
        cacheRoot: path.join(settings.supabaseHome, "cache", "stack"),
      })
      .pipe(Effect.mapError(runtimeError));
    const composition = yield* stack.composition.describe.pipe(Effect.mapError(runtimeError));
    if (composition.members.length === 0)
      return yield* new StackCommandRestartError({
        reason: "lifecycle",
        message: "The selected stack has not been configured yet.",
        suggestion: "Run supabase stack start first.",
      });
    const task = yield* output.task("Restarting the saved stack composition...");
    const observations = yield* stack.composition.restart.pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? task.clear()
          : Cause.hasInterruptsOnly(exit.cause)
            ? task.cancel()
            : task.fail(Option.getOrUndefined(Exit.findErrorOption(exit))?.message),
      ),
      Effect.mapError(runtimeError),
    );
    const services = observations.map(({ id, config, lifecycle, health, wakeEnabled }) => ({
      id,
      service: config.service,
      lifecycle,
      health,
      wake_enabled: wakeEnabled,
    }));
    if (output.format === "text") {
      yield* output.raw(`Stack ${stack.id} restarted using its saved configuration.\n`);
      for (const service of services)
        yield* output.raw(
          `  ${service.service}: ${service.lifecycle}, health ${service.health ?? "unavailable"}\n`,
        );
    } else yield* output.success("", { id: stack.id, services });
    return services;
  }).pipe(Effect.ensuring(telemetry.flush));
});
