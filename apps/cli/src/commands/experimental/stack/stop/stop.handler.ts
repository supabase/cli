import { Effect, Match, Option } from "effect";
import {
  isStackError,
  isStackId,
  StackIdSchema,
  type StackDescriptor,
} from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { ExperimentalStackApi } from "../stack.shared.ts";
import { ExperimentalStackStopError } from "./stop.errors.ts";

export interface ExperimentalStackStopFlags {
  readonly stack: Option.Option<string>;
  readonly stackId: Option.Option<string>;
}

export const validateExperimentalStackStopTarget = (
  flags: Pick<ExperimentalStackStopFlags, "stack" | "stackId">,
) =>
  Option.isSome(flags.stack) && Option.isSome(flags.stackId)
    ? Effect.fail(
        new ExperimentalStackStopError({
          reason: "flags",
          message: "--stack and --stack-id cannot be used together",
        }),
      )
    : Effect.void;

const stopError = (error: unknown): ExperimentalStackStopError => {
  const stackError = isStackError(error) ? error : undefined;
  const classification =
    stackError === undefined
      ? { reason: "unknown" as const }
      : Match.value(stackError).pipe(
          Match.tag("StackNotFoundError", "InvalidStackIdentityError", () => ({
            reason: "flags" as const,
          })),
          Match.tag(
            "StackOwnershipConflictError",
            "StackNotRunningError",
            "StackMustBeStoppedError",
            "StackLifecycleConflictError",
            "StackRuntimeError",
            "StackCleanupError",
            () => ({ reason: "lifecycle" as const }),
          ),
          Match.tag(
            "InvalidStackConfigError",
            "StackStateFormatUnsupportedError",
            "InvalidProjectRootError",
            "StackStateInvalidError",
            () => ({ reason: "invalid-config" as const }),
          ),
          Match.tag("StackUpgradeRequiredError", () => ({ reason: "lifecycle" as const })),
          Match.orElse(() => ({ reason: "unknown" as const })),
        );
  return new ExperimentalStackStopError({
    ...classification,
    message: stackError?.message ?? String(error),
    cause: error,
  });
};

const stoppedPayload = (id: StackDescriptor["id"]) => ({ found: true, id, lifecycle: "stopped" });

export const experimentalStackStop = Effect.fn("experimental.stack.stop")(function* (
  flags: ExperimentalStackStopFlags,
) {
  const telemetryState = yield* TelemetryState;
  const body = Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const stackApi = yield* ExperimentalStackApi;
    const outputFlag = yield* Effect.serviceOption(OutputFlag);
    if (Option.isSome(outputFlag) && Option.isSome(outputFlag.value))
      return yield* new ExperimentalStackStopError({
        reason: "flags",
        message: "The legacy -o/--output flag is not supported here; use --output-format json.",
        suggestion:
          "Use --output-format json, --output-format text, or --output-format stream-json.",
      });
    yield* validateExperimentalStackStopTarget(flags);

    const id = Option.isSome(flags.stackId) ? flags.stackId.value : undefined;
    const targetOption =
      id === undefined
        ? yield* stackApi
            .findStack({
              projectRoot: settings.workdir,
              ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
            })
            .pipe(Effect.mapError(stopError))
        : yield* isStackId(id)
            ? Effect.succeed(
                Option.some({
                  id: StackIdSchema.make(id),
                  projectRoot: settings.workdir,
                }),
              )
            : Effect.fail(
                new ExperimentalStackStopError({
                  reason: "flags",
                  message: "--stack-id must be a lowercase SHA-256 stack id",
                }),
              );
    if (Option.isNone(targetOption)) {
      if (Option.isSome(flags.stack))
        return yield* new ExperimentalStackStopError({
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
    yield* stack.stop().pipe(
      Effect.tapError((error) => stopping.fail(error.message)),
      Effect.tap(() => stopping.clear()),
      Effect.mapError(stopError),
    );
    if (output.format === "text") yield* output.raw(`Stack ${target.id} stopped.\n`);
    else yield* output.success("", stoppedPayload(target.id));
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
