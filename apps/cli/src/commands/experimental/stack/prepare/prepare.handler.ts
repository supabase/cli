import { Effect, Option } from "effect";
import type { PrepareStackResult, StackRuntimePreference } from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyCliSettings } from "../../../../config/legacy-cli-settings.service.ts";
import {
  LegacyExperimentalStackApi,
  LegacyExperimentalStackTargetResolver,
} from "../stack.shared.ts";
import { legacyLoadStackConfig } from "../stack-config.ts";
import type { LegacyExperimentalStackPrepareFlags } from "./prepare.command.ts";
import { LegacyExperimentalStackPrepareError, legacyStackPrepareError } from "./prepare.errors.ts";

const resultPayload = (id: string, result: PrepareStackResult) => ({
  id,
  capabilities: result.capabilities,
});

const renderResult = (id: string, result: PrepareStackResult): string => {
  const lines = [`Stack ${id} prepared.`];
  if (result.capabilities.length === 0) return `${lines[0]}\n`;
  lines.push("Capabilities:");
  for (const capability of result.capabilities)
    lines.push(`  ${capability.capability} ${capability.version} (${capability.outcome})`);
  return `${lines.join("\n")}\n`;
};

export const legacyValidateExperimentalStackPrepareTarget = (
  flags: Pick<LegacyExperimentalStackPrepareFlags, "stack" | "stackId">,
) =>
  Option.isSome(flags.stack) && Option.isSome(flags.stackId)
    ? Effect.fail(
        new LegacyExperimentalStackPrepareError({
          reason: "flags",
          message: "--stack and --stack-id cannot be used together",
        }),
      )
    : Effect.void;

export const legacyExperimentalStackPrepare = Effect.fn("legacy.experimental.stack.prepare")(
  function* (flags: LegacyExperimentalStackPrepareFlags) {
    const output = yield* Output;
    const settings = yield* LegacyCliSettings;
    const resolver = yield* LegacyExperimentalStackTargetResolver;
    const stackApi = yield* LegacyExperimentalStackApi;
    const legacyOutput = yield* Effect.serviceOption(LegacyOutputFlag);
    if (Option.isSome(legacyOutput) && Option.isSome(legacyOutput.value))
      return yield* new LegacyExperimentalStackPrepareError({
        reason: "flags",
        message: "The legacy -o/--output flag is not supported here; use --output-format json.",
        suggestion: "Use --output-format json or --output-format text.",
      });
    yield* legacyValidateExperimentalStackPrepareTarget(flags);

    const target = yield* resolver.resolve({
      projectRoot: settings.workdir,
      ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
      ...(Option.isSome(flags.stackId) ? { id: flags.stackId.value } : {}),
      runtime: flags.runtime,
    });
    const config = yield* legacyLoadStackConfig(target.projectRoot).pipe(
      Effect.mapError(
        (error) =>
          new LegacyExperimentalStackPrepareError({
            reason: "invalid-config",
            message: error.message,
            cause: error,
          }),
      ),
    );
    const disabledCapability = flags.capability.find((capability) => {
      const selected = config.capabilities?.[capability];
      return selected !== undefined && "enabled" in selected && selected.enabled === false;
    });
    if (disabledCapability !== undefined)
      return yield* new LegacyExperimentalStackPrepareError({
        reason: "invalid-config",
        message: `Capability ${disabledCapability} is disabled in config.toml.`,
        suggestion: `Enable ${disabledCapability} in config.toml or drop --capability ${disabledCapability}.`,
      });
    const runtime: StackRuntimePreference | undefined = target.runtime;
    const stack =
      target.id !== undefined
        ? yield* stackApi.openStack(target.id).pipe(Effect.mapError(legacyStackPrepareError))
        : yield* stackApi
            .createStack({
              projectRoot: target.projectRoot,
              ...(target.name === undefined ? {} : { name: target.name }),
              ...(runtime === undefined ? {} : { runtime }),
            })
            .pipe(Effect.mapError(legacyStackPrepareError));

    const task = yield* output.task("Preparing local Supabase stack...");
    const result = yield* stack
      .prepare({
        config,
        ...(flags.capability.length === 0 ? {} : { capabilities: flags.capability }),
      })
      .pipe(
        Effect.tapError((error) => task.fail(error.message)),
        Effect.tap(() => task.clear()),
        Effect.mapError(legacyStackPrepareError),
      );
    const payload = resultPayload(stack.id, result);
    if (output.format === "text") yield* output.raw(renderResult(stack.id, result));
    else yield* output.success("", payload);
    return result;
  },
);
