import { Effect, Match, Option, Result } from "effect";
import {
  type StackDescriptor,
  type OpenStackError,
  type StackDiscoveryError,
  type StackStopError as ApiStackStopError,
} from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import {
  StackApi,
  StackTargetError,
  rejectStackOutput,
  validateStackId,
  validateStackTarget,
} from "../stack.shared.ts";
import type { StackStopFlags } from "./stop.command.ts";
import { StackCommandStopError } from "./stop.errors.ts";

const mapTargetError = (error: StackTargetError) =>
  new StackCommandStopError({
    reason: error.reason,
    message: error.message,
    ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
    cause: error,
  });

const stopError = (error: StackDiscoveryError | OpenStackError | ApiStackStopError) => {
  const classification = Match.value(error).pipe(
    Match.tag("StackNotFoundError", "InvalidStackIdentityError", () => ({
      reason: "flags" as const,
    })),
    Match.tag("StackOwnershipConflictError", () => ({
      reason: "unknown" as const,
      suggestion:
        "Retry the stack stop; if it remains owned, rerun with --debug and inspect cleanup diagnostics.",
    })),
    Match.tag("StackLifecycleConflictError", "StackUpgradeRequiredError", () => ({
      reason: "lifecycle" as const,
    })),
    Match.tag(
      "StackStateFormatUnsupportedError",
      "InvalidProjectRootError",
      "StackStateInvalidError",
      () => ({ reason: "invalid-config" as const }),
    ),
    Match.tag("StackRuntimeMismatchError", () => ({ reason: "unknown" as const })),
    Match.tag("StackCleanupError", () => ({
      reason: "unknown" as const,
      suggestion: "Retry the stack stop with --debug and inspect cleanup diagnostics.",
    })),
    Match.exhaustive,
  );
  return new StackCommandStopError({
    ...classification,
    message: error.message,
    cause: error,
  });
};

const stoppedPayload = (id: StackDescriptor["id"]) => ({ found: true, id, lifecycle: "stopped" });

export const stackStop = Effect.fn("experimental.stack.stop")(function* (flags: StackStopFlags) {
  const telemetryState = yield* TelemetryState;
  const body = Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const stackApi = yield* StackApi;
    const outputFlag = yield* Effect.serviceOption(OutputFlag);
    const stopAll = Option.getOrElse(flags.all, () => false);
    yield* rejectStackOutput(outputFlag).pipe(Effect.mapError(mapTargetError));
    if (Option.isSome(flags.all) && (Option.isSome(flags.stack) || Option.isSome(flags.stackId)))
      return yield* new StackCommandStopError({
        reason: "flags",
        message: "--all cannot be combined with --stack or --stack-id",
      });
    yield* validateStackTarget({
      stack: Option.getOrUndefined(flags.stack),
      stackId: Option.getOrUndefined(flags.stackId),
    }).pipe(Effect.mapError(mapTargetError));

    if (stopAll) {
      const discovered = yield* stackApi.discoverStacks().pipe(Effect.mapError(stopError));
      for (const issue of discovered.errors)
        yield* output.warn(`Skipping managed stack: ${issue.error.message}`);
      const stopping = yield* output.task(
        `Stopping ${discovered.stacks.length} managed stack(s)...`,
      );
      const results = yield* Effect.forEach(
        discovered.stacks,
        (descriptor) =>
          stackApi.openStack(descriptor.id).pipe(
            Effect.flatMap((stack) => stack.stop),
            Effect.result,
            Effect.map((result) => ({ descriptor, result })),
          ),
        { concurrency: 1 },
      );
      const failed = results.flatMap(({ descriptor, result }) =>
        Result.isFailure(result) ? [{ descriptor, error: result.failure }] : [],
      );
      if (failed.length > 0 || discovered.errors.length > 0) {
        const message = `Stopped ${discovered.stacks.length - failed.length} managed stack(s); failed ${failed.length}; skipped ${discovered.errors.length}`;
        const detail = [
          ...failed.map(
            ({ descriptor, error }) =>
              `Failed to stop managed stack ${descriptor.id}: ${error.message}`,
          ),
          ...discovered.errors.map(({ error }) => `Skipped managed stack: ${error.message}`),
        ].join("\n");
        yield* stopping.fail(message);
        const classifications = [
          ...failed.map(({ error }) => stopError(error)),
          ...discovered.errors.map(({ error }) => stopError(error)),
        ];
        const firstClassification = classifications[0];
        const reason =
          firstClassification !== undefined &&
          classifications.every(
            (classification) => classification.reason === firstClassification.reason,
          )
            ? firstClassification.reason
            : "unknown";
        const suggestion =
          firstClassification?.suggestion !== undefined &&
          classifications.every(
            (classification) => classification.suggestion === firstClassification.suggestion,
          )
            ? firstClassification.suggestion
            : undefined;
        return yield* new StackCommandStopError({
          reason,
          message,
          detail,
          ...(suggestion === undefined ? {} : { suggestion }),
          cause: { failures: failed, discovery: discovered.errors },
        });
      }
      yield* stopping.clear();
      if (output.format === "text")
        yield* output.raw(`Stopped ${discovered.stacks.length} managed stack(s).\n`);
      else yield* output.success("", { stopped: discovered.stacks.map(({ id }) => id) });
      return;
    }

    const id = Option.isSome(flags.stackId) ? flags.stackId.value : undefined;
    const targetOption =
      id === undefined
        ? yield* stackApi
            .findStack({
              projectRoot: settings.workdir,
              ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
            })
            .pipe(Effect.mapError(stopError))
        : yield* validateStackId(id).pipe(
            Effect.mapError(mapTargetError),
            Effect.map((validId) =>
              Option.some({
                id: validId,
                projectRoot: settings.workdir,
              }),
            ),
          );
    if (Option.isNone(targetOption)) {
      if (Option.isSome(flags.stack))
        return yield* new StackCommandStopError({
          reason: "flags",
          message: `No managed stack named "${flags.stack.value}" was found for this project.`,
          suggestion: "Choose an existing --stack name or omit --stack for the current project.",
        });
      yield* output.success("No managed stack found for this context.", { found: false });
      return;
    }
    const target = targetOption.value;
    const stack = yield* stackApi.openStack(target.id).pipe(Effect.mapError(stopError));
    const stopping = yield* output.task(`Stopping stack ${target.id}...`);
    yield* stack.stop.pipe(
      Effect.tapError((error) => stopping.fail(error.message)),
      Effect.tap(() => stopping.clear()),
      Effect.mapError(stopError),
    );
    if (output.format === "text") yield* output.raw(`Stack ${target.id} stopped.\n`);
    else yield* output.success("", stoppedPayload(target.id));
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
