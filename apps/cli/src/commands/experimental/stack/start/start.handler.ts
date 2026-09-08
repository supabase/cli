import { Effect, Match, Option } from "effect";
import {
  isStackError,
  type StackStatus,
  type StackRuntimePreference,
} from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { ExperimentalStackApi, ExperimentalStackTargetResolver } from "../stack.shared.ts";
import { loadStackConfig } from "../stack-config.ts";
import type { ExperimentalStackStartFlags } from "./start.command.ts";
import { ExperimentalStackStartError, ExperimentalStackTargetFlagsError } from "./start.errors.ts";

const statusPayload = (status: StackStatus) => ({
  id: status.id,
  lifecycle: status.lifecycle,
  desired_lifecycle: status.desiredLifecycle,
  runtime: status.runtime,
  endpoints: status.endpoints,
  versions: status.versions,
  capabilities: status.capabilities,
  artifacts: status.artifacts,
});

const renderStatus = (status: StackStatus): string => {
  const lines = [
    `Stack ${status.id}`,
    `Runtime: ${status.runtime.kind}`,
    `Lifecycle: ${status.lifecycle}`,
  ];
  const endpoints = Object.entries(status.endpoints);
  if (endpoints.length > 0) {
    lines.push("Endpoints:");
    for (const [name, endpoint] of endpoints) {
      if (endpoint !== undefined) lines.push(`  ${name}: ${endpoint.url}`);
    }
  }
  const dormant = status.capabilities.filter((capability) => capability.state === "dormant");
  if (dormant.length > 0)
    lines.push(`Dormant capabilities: ${dormant.map(({ name }) => name).join(", ")}`);
  return `${lines.join("\n")}\n`;
};

const eagerlyActivate = <
  T extends { readonly enabled?: boolean; readonly activation?: "eager" | "lazy" },
>(
  value: T,
): T => (value.enabled === false ? value : Object.assign({}, value, { activation: "eager" }));

const validateExperimentalStackStartTarget = (
  flags: Pick<ExperimentalStackStartFlags, "stack" | "stackId">,
) =>
  Option.isSome(flags.stack) && Option.isSome(flags.stackId)
    ? Effect.fail(
        new ExperimentalStackTargetFlagsError({
          message: "--stack and --stack-id cannot be used together",
        }),
      )
    : Effect.void;

export const experimentalStackStart = Effect.fn("experimental.stack.start")(function* (
  flags: ExperimentalStackStartFlags,
) {
  const telemetryState = yield* TelemetryState;
  const body = Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const resolver = yield* ExperimentalStackTargetResolver;
    const stackApi = yield* ExperimentalStackApi;
    const outputFlag = yield* Effect.serviceOption(OutputFlag);
    if (Option.isSome(outputFlag) && Option.isSome(outputFlag.value))
      return yield* new ExperimentalStackStartError({
        reason: "flags",
        message: "The legacy -o/--output flag is not supported here; use --output-format json.",
        suggestion: "Use --output-format json or --output-format text.",
      });
    yield* validateExperimentalStackStartTarget(flags);

    const target = yield* resolver.resolve({
      projectRoot: settings.workdir,
      ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
      ...(Option.isSome(flags.stackId) ? { id: flags.stackId.value } : {}),
      runtime: flags.runtime,
    });
    const config = yield* loadStackConfig(target.projectRoot).pipe(
      Effect.mapError(
        (error) =>
          new ExperimentalStackStartError({
            reason: "invalid-config",
            message: error.message,
            cause: error,
          }),
      ),
    );
    const startConfig = flags.eager
      ? {
          ...config,
          capabilities: {
            ...config.capabilities,
            ...(config.capabilities?.rest === undefined
              ? {}
              : { rest: eagerlyActivate(config.capabilities.rest) }),
            ...(config.capabilities?.auth === undefined
              ? {}
              : { auth: eagerlyActivate(config.capabilities.auth) }),
            ...(config.capabilities?.realtime === undefined
              ? {}
              : { realtime: eagerlyActivate(config.capabilities.realtime) }),
            ...(config.capabilities?.storage === undefined
              ? {}
              : { storage: eagerlyActivate(config.capabilities.storage) }),
            ...(config.capabilities?.functions === undefined
              ? {}
              : { functions: eagerlyActivate(config.capabilities.functions) }),
            ...(config.capabilities?.studio === undefined
              ? {}
              : { studio: eagerlyActivate(config.capabilities.studio) }),
            ...(config.capabilities?.mail === undefined
              ? {}
              : { mail: eagerlyActivate(config.capabilities.mail) }),
            ...(config.capabilities?.analytics === undefined
              ? {}
              : { analytics: eagerlyActivate(config.capabilities.analytics) }),
            ...(config.capabilities?.pooler === undefined
              ? {}
              : { pooler: eagerlyActivate(config.capabilities.pooler) }),
          },
          preparation: flags.preparation,
        }
      : { ...config, preparation: flags.preparation };
    const runtime: StackRuntimePreference | undefined = target.runtime;
    // The package's public Effect API reads SUPABASE_HOME only at its runtime
    // composition boundary and launches the detached owner through the compiled
    // dispatch sentinel. The CLI adapter resolves the target and config; it does
    // not recreate package lifecycle or runtime ownership here.
    const stack =
      target.id !== undefined
        ? yield* stackApi.openStack(target.id).pipe(Effect.mapError(stackStartError))
        : yield* stackApi
            .createStack({
              projectRoot: target.projectRoot,
              ...(target.name === undefined ? {} : { name: target.name }),
              ...(runtime === undefined ? {} : { runtime }),
            })
            .pipe(Effect.mapError(stackStartError));
    const starting = yield* output.task("Starting local Supabase stack...");
    const status = yield* stack.start({ config: startConfig }).pipe(
      Effect.tapError((error) => starting.fail(error.message)),
      Effect.tap(() => starting.succeed("Stack is ready.")),
      Effect.mapError(stackStartError),
    );
    if (output.format === "text") {
      yield* output.raw(renderStatus(status));
    } else {
      yield* output.success("", statusPayload(status));
    }
    return status;
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});

const stackStartError = (error: unknown) => {
  const stackError = isStackError(error) ? error : undefined;
  const message = stackError === undefined ? String(error) : stackError.message;
  const classification =
    stackError === undefined
      ? { reason: "unknown" as const }
      : Match.value(stackError).pipe(
          Match.tag("ContainerEngineError", () => ({
            reason: "runtime" as const,
            suggestion: "Ensure the selected container engine is running and retry the command.",
          })),
          Match.tag("ContainerPullError", () => ({
            reason: "registry" as const,
            suggestion:
              "Check registry connectivity and image availability, then retry the command.",
          })),
          Match.tag("PortUnavailableError", "PortAllocationError", () => ({
            reason: "port" as const,
            suggestion:
              "Free the conflicting port or update the local stack port configuration, then retry.",
          })),
          Match.tag("StackPreparationError", "ArtifactIntegrityError", () => ({
            reason: "artifact" as const,
            suggestion: "Retry the stack start with --debug if the artifact cannot be prepared.",
          })),
          Match.tag("StackRuntimeMismatchError", () => ({
            reason: "flags" as const,
            suggestion:
              "Omit --runtime to reuse the existing runtime, or choose a different --stack name.",
          })),
          Match.tag(
            "InvalidStackConfigError",
            "StackVersionUnsupportedError",
            "InvalidStackIdentityError",
            "InvalidProjectRootError",
            "StackSecretMismatchError",
            "InvalidJwtSigningMaterialError",
            () => ({ reason: "invalid-config" as const }),
          ),
          Match.tag("StackStateInvalidError", () => ({
            reason: "invalid-config" as const,
            suggestion:
              "Inspect the reported state error and restore a valid state record before retrying.",
          })),
          Match.tag("StackStateFormatUnsupportedError", () => ({
            reason: "invalid-config" as const,
            suggestion: "Use a CLI version compatible with the persisted stack state.",
          })),
          Match.tag("StackNotFoundError", () => ({ reason: "flags" as const })),
          Match.tag(
            "StackOwnershipConflictError",
            "StackNotRunningError",
            "StackMustBeStoppedError",
            "StackLifecycleConflictError",
            "StackUpgradeRequiredError",
            () => ({
              reason: "lifecycle" as const,
              suggestion: "Stop the stack before starting it again.",
            }),
          ),
          Match.tag("StackRuntimeError", () => ({
            reason: "unknown" as const,
            suggestion: "Retry the stack start with --debug and inspect the runtime diagnostics.",
          })),
          Match.tag("StackCleanupError", () => ({
            reason: "unknown" as const,
            suggestion: "Retry the stack start with --debug and inspect cleanup diagnostics.",
          })),
          Match.orElse(() => ({ reason: "unknown" as const })),
        );
  return new ExperimentalStackStartError({
    ...classification,
    message,
    ...("suggestion" in classification ? { suggestion: classification.suggestion } : {}),
    cause: error,
  });
};
