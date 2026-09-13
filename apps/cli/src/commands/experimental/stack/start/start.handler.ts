import { Effect, FileSystem, Match, Option, Path } from "effect";
import {
  excludeStackCapabilities,
  isStackError,
  type StackStatus,
  type StackRuntimePreference,
} from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { readDbToml } from "../../../../command-internal/db-config.toml-read.ts";
import { StackCatalogSetup } from "../../../../command-internal/stack-catalog-setup.ts";
import {
  StackApi,
  StackTargetError,
  StackTargetResolver,
  rejectStackOutput,
  validateStackTarget,
} from "../stack.shared.ts";
import { loadStackConfig } from "../stack-config.ts";
import type { StackStartFlags } from "./start.command.ts";
import { StackCommandStartError } from "./start.errors.ts";
import { STACK_START_EXCLUDABLE_CAPABILITIES } from "./start.options.ts";

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

const validateExclusions = (exclusions: ReadonlyArray<string>) => {
  const unknown = exclusions.filter(
    (name) =>
      name !== "database" &&
      !STACK_START_EXCLUDABLE_CAPABILITIES.some((capability) => capability === name),
  );
  if (unknown.length > 0)
    return Effect.fail(
      new StackCommandStartError({
        reason: "flags",
        message: `Unknown stack capabilities in --exclude: ${unknown.map((name) => JSON.stringify(name)).join(", ")}`,
        suggestion: `Choose from ${STACK_START_EXCLUDABLE_CAPABILITIES.join(", ")}.`,
      }),
    );
  if (exclusions.includes("database"))
    return Effect.fail(
      new StackCommandStartError({
        reason: "flags",
        message: "The database capability cannot be excluded from a stack.",
        suggestion: "Remove database from --exclude.",
      }),
    );
  return Effect.succeed(
    STACK_START_EXCLUDABLE_CAPABILITIES.filter((name) => exclusions.includes(name)),
  );
};

const mapTargetError = (error: StackTargetError) =>
  new StackCommandStartError({
    reason: error.reason,
    message: error.message,
    ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
    cause: error,
  });

export const stackStart = Effect.fn("experimental.stack.start")(function* (flags: StackStartFlags) {
  const telemetryState = yield* TelemetryState;
  const body = Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const resolver = yield* StackTargetResolver;
    const stackApi = yield* StackApi;
    const outputFlag = yield* Effect.serviceOption(OutputFlag);
    yield* rejectStackOutput(outputFlag).pipe(Effect.mapError(mapTargetError));
    const exclusions = yield* validateExclusions(flags.exclude);
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
          new StackCommandStartError({
            reason: "invalid-config",
            message: error.message,
            cause: error,
          }),
      ),
    );
    const configuredStart = excludeStackCapabilities(config, exclusions);
    const startConfig = flags.eager
      ? {
          ...configuredStart,
          capabilities: {
            ...configuredStart.capabilities,
            ...(configuredStart.capabilities?.rest === undefined
              ? {}
              : { rest: eagerlyActivate(configuredStart.capabilities.rest) }),
            ...(configuredStart.capabilities?.auth === undefined
              ? {}
              : { auth: eagerlyActivate(configuredStart.capabilities.auth) }),
            ...(configuredStart.capabilities?.realtime === undefined
              ? {}
              : { realtime: eagerlyActivate(configuredStart.capabilities.realtime) }),
            ...(configuredStart.capabilities?.storage === undefined
              ? {}
              : { storage: eagerlyActivate(configuredStart.capabilities.storage) }),
            ...(configuredStart.capabilities?.functions === undefined
              ? {}
              : { functions: eagerlyActivate(configuredStart.capabilities.functions) }),
            ...(configuredStart.capabilities?.studio === undefined
              ? {}
              : { studio: eagerlyActivate(configuredStart.capabilities.studio) }),
            ...(configuredStart.capabilities?.mail === undefined
              ? {}
              : { mail: eagerlyActivate(configuredStart.capabilities.mail) }),
            ...(configuredStart.capabilities?.analytics === undefined
              ? {}
              : { analytics: eagerlyActivate(configuredStart.capabilities.analytics) }),
            ...(configuredStart.capabilities?.pooler === undefined
              ? {}
              : { pooler: eagerlyActivate(configuredStart.capabilities.pooler) }),
          },
          preparation: flags.preparation,
        }
      : { ...configuredStart, preparation: flags.preparation };
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
      Effect.mapError(stackStartError),
    );
    const catalog = yield* Effect.serviceOption(StackCatalogSetup);
    if (Option.isNone(catalog))
      return yield* new StackCommandStartError({
        reason: "unknown",
        message: "stack catalog setup is unavailable",
      });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const toml = yield* readDbToml(fs, path, target.projectRoot).pipe(
      Effect.mapError(
        (error) =>
          new StackCommandStartError({
            reason: "invalid-config",
            message: error.message,
            cause: error,
          }),
      ),
    );
    yield* catalog.value
      .apply({
        target: {
          kind: "live",
          stack,
          projectRoot: target.projectRoot,
          config,
        },
        overlay: {
          webhooks: "config",
          webhooksEnabled: toml.webhooksEnabled,
          apiAutoExposeNewTables: toml.baseline.apiAutoExposeNewTables,
          vault: toml.vault,
          workdir: target.projectRoot,
        },
      })
      .pipe(
        Effect.tapError((error) => starting.fail(error.message)),
        Effect.mapError((error) =>
          isStackError(error.cause)
            ? stackStartError(error.cause)
            : new StackCommandStartError({
                reason: "unknown",
                message: error.message,
                cause: error,
              }),
        ),
      );
    yield* starting.succeed("Stack is ready.");
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
            suggestion:
              "Check that the selected container engine is installed and its daemon is running, then retry the command.",
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
  return new StackCommandStartError({
    ...classification,
    message,
    ...("suggestion" in classification ? { suggestion: classification.suggestion } : {}),
    cause: error,
  });
};
