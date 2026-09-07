import { Effect, Match, Option } from "effect";
import {
  isStackError,
  type StackStatus,
  type StackRuntimePreference,
} from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyCliSettings } from "../../../../config/legacy-cli-settings.service.ts";
import {
  LegacyExperimentalStackApi,
  LegacyExperimentalStackTargetResolver,
} from "../stack.shared.ts";
import { legacyLoadStackConfig } from "../stack-config.ts";
import type { LegacyExperimentalStackStartFlags } from "./start.command.ts";
import {
  LegacyExperimentalStackStartError,
  LegacyExperimentalStackTargetFlagsError,
} from "./start.errors.ts";

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

export const legacyValidateExperimentalStackStartTarget = (
  flags: Pick<LegacyExperimentalStackStartFlags, "stack" | "stackId">,
) =>
  Option.isSome(flags.stack) && Option.isSome(flags.stackId)
    ? Effect.fail(
        new LegacyExperimentalStackTargetFlagsError({
          message: "--stack and --stack-id cannot be used together",
        }),
      )
    : Effect.void;

export const legacyExperimentalStackStart = Effect.fn("legacy.experimental.stack.start")(function* (
  flags: LegacyExperimentalStackStartFlags,
) {
  const output = yield* Output;
  const settings = yield* LegacyCliSettings;
  const resolver = yield* LegacyExperimentalStackTargetResolver;
  const stackApi = yield* LegacyExperimentalStackApi;
  const legacyOutput = yield* Effect.serviceOption(LegacyOutputFlag);
  if (Option.isSome(legacyOutput) && Option.isSome(legacyOutput.value))
    return yield* new LegacyExperimentalStackStartError({
      reason: "flags",
      message: "The legacy -o/--output flag is not supported here; use --output-format json.",
      suggestion: "Use --output-format json or --output-format text.",
    });
  yield* legacyValidateExperimentalStackStartTarget(flags);

  const target = yield* resolver.resolve({
    projectRoot: settings.workdir,
    ...(Option.isSome(flags.stack) ? { name: flags.stack.value } : {}),
    ...(Option.isSome(flags.stackId) ? { id: flags.stackId.value } : {}),
    runtime: flags.runtime,
  });
  const config = yield* legacyLoadStackConfig(target.projectRoot).pipe(
    Effect.mapError(
      (error) =>
        new LegacyExperimentalStackStartError({
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
      ? yield* stackApi.openStack(target.id).pipe(Effect.mapError(legacyStackStartError))
      : yield* stackApi
          .createStack({
            projectRoot: target.projectRoot,
            ...(target.name === undefined ? {} : { name: target.name }),
            ...(runtime === undefined ? {} : { runtime }),
          })
          .pipe(Effect.mapError(legacyStackStartError));
  const starting = yield* output.task("Starting local Supabase stack...");
  const status = yield* stack.start({ config: startConfig }).pipe(
    Effect.tapError((error) => starting.fail(error.message)),
    Effect.tap(() => starting.succeed("Stack is ready.")),
    Effect.mapError(legacyStackStartError),
  );
  if (output.format === "text") {
    yield* output.raw(renderStatus(status));
  } else {
    yield* output.success("", statusPayload(status));
  }
  return status;
});

const legacyStackStartError = (error: unknown) => {
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
            () => ({
              reason: "invalid-config" as const,
            }),
          ),
          Match.tag("StackNotFoundError", () => ({ reason: "flags" as const })),
          Match.tag(
            "StackOwnershipConflictError",
            "StackNotRunningError",
            "StackMustBeStoppedError",
            "StackLifecycleConflictError",
            "StackUpgradeRequiredError",
            "StackRuntimeError",
            "StackCleanupError",
            () => ({
              reason: "lifecycle" as const,
              suggestion: "Stop the stack before starting it again.",
            }),
          ),
          Match.orElse(() => ({ reason: "unknown" as const })),
        );
  return new LegacyExperimentalStackStartError({
    ...classification,
    message,
    ...("suggestion" in classification ? { suggestion: classification.suggestion } : {}),
    cause: error,
  });
};
