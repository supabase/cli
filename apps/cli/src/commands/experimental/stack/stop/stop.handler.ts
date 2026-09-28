import { Effect, Option, Path, Result } from "effect";
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
import type { StackStopFlags } from "./stop.command.ts";
import { StackCommandStopError } from "./stop.errors.ts";

const stopError = (cause: { readonly message: string }) =>
  new StackCommandStopError({
    reason: "invalid-config",
    message: cause.message,
    cause,
  });

export const stackStop = Effect.fn("experimental.stack.stop")(function* (flags: StackStopFlags) {
  const telemetry = yield* TelemetryState;
  return yield* Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const path = yield* Path.Path;
    const api = yield* StackApi;
    const resolver = yield* StackTargetResolver;
    yield* rejectStackOutput(yield* Effect.serviceOption(OutputFlag)).pipe(
      Effect.mapError(
        (cause) =>
          new StackCommandStopError({
            reason: cause.reason,
            message: cause.message,
            ...(cause.suggestion === undefined ? {} : { suggestion: cause.suggestion }),
            cause,
          }),
      ),
    );
    if (Option.isSome(flags.all) && (Option.isSome(flags.stack) || Option.isSome(flags.stackId)))
      return yield* new StackCommandStopError({
        reason: "flags",
        message: "--all cannot be combined with --stack or --stack-id",
      });
    yield* validateStackTarget({
      stack: Option.getOrUndefined(flags.stack),
      stackId: Option.getOrUndefined(flags.stackId),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new StackCommandStopError({
            reason: cause.reason,
            message: cause.message,
            ...(cause.suggestion === undefined ? {} : { suggestion: cause.suggestion }),
            cause,
          }),
      ),
    );
    const all = Option.getOrElse(flags.all, () => false);
    const target = all
      ? undefined
      : yield* resolver
          .resolve({
            projectRoot: settings.workdir,
            ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
            ...(Option.isSome(flags.stackId) ? { id: flags.stackId.value } : {}),
            runtime: "auto",
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new StackCommandStopError({
                  reason: cause.reason,
                  message: cause.message,
                  ...(cause.suggestion === undefined ? {} : { suggestion: cause.suggestion }),
                  cause,
                }),
            ),
          );
    const locations = {
      stateRoot: path.join(settings.supabaseHome, "stacks"),
      cacheRoot: path.join(settings.supabaseHome, "cache", "stack"),
    };
    const selected =
      target === undefined
        ? yield* api
            .discover({
              ...locations,
              onInvalidState: (id, error) =>
                output.raw(`Warning: skipping invalid stack ${id}: ${error.message}\n`, "stderr"),
            })
            .pipe(
              Effect.map((discovered) =>
                discovered.map(({ definition, host }) => ({
                  id: definition.id,
                  hostRunning: host !== undefined,
                })),
              ),
              Effect.mapError(stopError),
            )
        : target.id === undefined
          ? undefined
          : [{ id: target.id, hostRunning: target.hostRunning }];
    if (selected === undefined) {
      if (Option.isSome(flags.stack))
        return yield* new StackCommandStopError({
          reason: "flags",
          message: `No managed stack named "${flags.stack.value}" was found for this project.`,
        });
      yield* output.success("No managed stack found for this context.", { found: false });
      return;
    }
    const results = yield* Effect.forEach(
      selected,
      ({
        id,
        hostRunning,
      }): Effect.Effect<{
        readonly id: string;
        readonly result: Result.Result<"stopped" | "unavailable", StackError>;
      }> =>
        !hostRunning
          ? Effect.succeed({ id, result: Result.succeed("unavailable" as const) })
          : api.open({ ...locations, id }).pipe(
              Effect.flatMap((stack) => stack.stop),
              Effect.scoped,
              Effect.as("stopped" as const),
              Effect.result,
              Effect.map((result) => ({ id, result })),
            ),
    );
    const failures = results.flatMap(({ id, result }) =>
      Result.isFailure(result) ? [{ id, error: result.failure }] : [],
    );
    if (failures.length > 0)
      return yield* new StackCommandStopError({
        reason: "unknown",
        message: `Failed to stop ${failures.length} managed stack(s).`,
        detail: failures.map(({ id, error }) => `${id}: ${error.message}`).join("\n"),
        cause: failures,
      });
    const stopped = results.flatMap(({ id, result }) =>
      Result.isSuccess(result) && result.success === "stopped" ? [id] : [],
    );
    const unavailable = results.flatMap(({ id, result }) =>
      Result.isSuccess(result) && result.success === "unavailable" ? [id] : [],
    );
    if (output.format === "text") {
      for (const id of stopped) yield* output.raw(`Stack ${id} stopped.\n`);
      for (const id of unavailable)
        yield* output.raw(`Stack ${id}: No owner is reachable; workload state is unavailable.\n`);
      if (results.length === 0) yield* output.raw("No managed stacks found.\n");
    } else yield* output.success("", { stopped, unavailable });
  }).pipe(Effect.ensuring(telemetry.flush));
});
