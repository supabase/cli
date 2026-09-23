import { Cause, Effect, Exit, Option, Path } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { loadStackConfig } from "../../../../command-internal/stack-config.ts";
import {
  StackApi,
  stackCapabilityForService,
  StackTargetError,
  rejectStackOutput,
  StackTargetResolver,
  validateStackTarget,
} from "../stack.shared.ts";
import type { StackPrepareFlags } from "./prepare.command.ts";
import { StackCommandPrepareError, stackPrepareError } from "./prepare.errors.ts";
import { defaultStackRuntime } from "../../../../command-internal/stack-runtime.ts";

type PreparedCapability = {
  readonly capability: string;
  readonly version?: string;
  readonly outcome: "prepared";
};

const mapTargetError = (error: StackTargetError) =>
  new StackCommandPrepareError({
    reason: error.reason,
    message: error.message,
    ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
    cause: error,
  });

const render = (id: string, capabilities: ReadonlyArray<PreparedCapability>) => {
  const lines = [`Stack ${id} prepared.`];
  if (capabilities.length > 0) {
    lines.push("Capabilities:");
    for (const capability of capabilities)
      lines.push(
        `  ${capability.capability} ${capability.version ?? "catalog default"} (${capability.outcome})`,
      );
  }
  return `${lines.join("\n")}\n`;
};

/** Prepares selected stack artifacts without starting service processes. */
export const stackPrepare = Effect.fn("experimental.stack.prepare")(function* (
  flags: StackPrepareFlags,
) {
  const telemetryState = yield* TelemetryState;
  const body = Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const path = yield* Path.Path;
    const runtime = yield* RuntimeInfo;
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
    const stateRoot = path.join(settings.supabaseHome, "stacks");
    const cacheRoot = path.join(settings.supabaseHome, "cache", "stack");
    const stack =
      target.id === undefined
        ? yield* api
            .create({
              projectRoot: target.projectRoot,
              stateRoot,
              cacheRoot,
              runtime: target.runtime ?? defaultStackRuntime(runtime),
              ...(target.name === undefined ? {} : { name: target.name }),
            })
            .pipe(Effect.mapError(stackPrepareError))
        : yield* api
            .open({ id: target.id, stateRoot, cacheRoot })
            .pipe(Effect.mapError(stackPrepareError));
    const creations = yield* config.creations(stack.id).pipe(
      Effect.mapError(
        (error) =>
          new StackCommandPrepareError({
            reason: "invalid-config",
            message: error.message,
            cause: error,
          }),
      ),
    );
    const selectedServices = flags.capability.length === 0 ? undefined : new Set(flags.capability);
    for (const capability of flags.capability) {
      if (!creations.some(({ service }) => stackCapabilityForService(service) === capability))
        return yield* new StackCommandPrepareError({
          reason: "invalid-config",
          message: `Service ${capability} is disabled in the project configuration`,
          suggestion: "Enable the service in supabase/config.toml before preparing it.",
        });
    }
    const requested =
      selectedServices === undefined
        ? creations
        : creations.filter(({ service }) =>
            selectedServices.has(stackCapabilityForService(service)),
          );
    const task = yield* output.task("Preparing local Supabase stack...");
    const capabilities = yield* Effect.forEach(requested, (creation) =>
      Effect.acquireUseRelease(
        stack.services.create(creation).pipe(Effect.mapError(stackPrepareError)),
        (instance) =>
          instance.prepare.pipe(Effect.mapError(stackPrepareError), Effect.as(creation)),
        (instance) =>
          instance.destroy.pipe(
            Effect.mapError(
              (cause) =>
                new StackCommandPrepareError({
                  reason: "lifecycle",
                  message: `Failed to remove temporary ${instance.service} instance ${instance.id}: ${cause.message}`,
                  suggestion: `Inspect stack ${stack.id}; run supabase stack destroy --stack-id ${stack.id} to remove it if no existing data must be retained.`,
                  cause,
                }),
            ),
          ),
      ),
    ).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? task.clear()
          : Option.match(Cause.findErrorOption(exit.cause), {
              onNone: () => (Cause.hasInterruptsOnly(exit.cause) ? task.cancel() : task.fail()),
              onSome: (error) => task.fail(error.message),
            }),
      ),
    );
    const prepared = capabilities.map((creation): PreparedCapability => ({
      capability: creation.service,
      ...(creation.service === "database"
        ? { version: creation.config.version }
        : creation.version === undefined
          ? {}
          : { version: creation.version }),
      outcome: "prepared",
    }));
    if (output.format === "text") yield* output.raw(render(stack.id, prepared));
    else yield* output.success("", { id: stack.id, capabilities: prepared });
    return prepared;
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
