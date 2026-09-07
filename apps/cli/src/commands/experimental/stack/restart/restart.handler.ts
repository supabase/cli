import { Effect, Match, Option } from "effect";
import { isStackError, isStackId, type StackStatus } from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyCliSettings } from "../../../../config/legacy-cli-settings.service.ts";
import { LegacyExperimentalStackApi } from "../stack.shared.ts";
import { legacyLoadStackConfig } from "../stack-config.ts";
import type { LegacyExperimentalStackRestartFlags } from "./restart.command.ts";
import { LegacyExperimentalStackRestartError } from "./restart.errors.ts";

const validateFlags = (flags: LegacyExperimentalStackRestartFlags) =>
  Option.isSome(flags.stack) && Option.isSome(flags.stackId)
    ? Effect.fail(
        new LegacyExperimentalStackRestartError({
          reason: "flags",
          message: "--stack and --stack-id cannot be used together",
        }),
      )
    : Effect.void;

const mapStackError = (error: import("@supabase/stack/effect").StackError) => {
  const classification = Match.value(error).pipe(
    Match.tag("StackNotFoundError", () => ({ reason: "not-found" as const })),
    Match.tag("InvalidStackIdentityError", () => ({ reason: "flags" as const })),
    Match.tag("PortUnavailableError", "PortAllocationError", () => ({
      reason: "port" as const,
      suggestion:
        "Free the conflicting port or update the local stack port configuration, then retry.",
    })),
    Match.tag(
      "InvalidStackConfigError",
      "StackVersionUnsupportedError",
      "InvalidProjectRootError",
      "StackStateInvalidError",
      "StackStateFormatUnsupportedError",
      "StackSecretMismatchError",
      "InvalidJwtSigningMaterialError",
      () => ({ reason: "invalid-config" as const }),
    ),
    Match.tag("StackRuntimeMismatchError", () => ({
      reason: "flags" as const,
      suggestion:
        "Restart preserves the existing runtime; choose a different --stack name to use another runtime.",
    })),
    Match.tag(
      "StackLifecycleConflictError",
      "StackNotRunningError",
      "StackMustBeStoppedError",
      "StackOwnershipConflictError",
      "StackUpgradeRequiredError",
      "StackRuntimeError",
      "StackCleanupError",
      () => ({
        reason: "lifecycle" as const,
        suggestion: "Run supabase experimental stack status to inspect the stack state.",
      }),
    ),
    Match.tag("ContainerEngineError", () => ({
      reason: "docker" as const,
      suggestion: "Ensure the selected container engine is running and retry the command.",
    })),
    Match.tag("ContainerPullError", () => ({
      reason: "registry" as const,
      suggestion: "Check registry connectivity and image availability, then retry the command.",
    })),
    Match.tag("ArtifactIntegrityError", "StackPreparationError", () => ({
      reason: "artifact" as const,
      suggestion: "Retry the stack restart with --debug if the artifact cannot be prepared.",
    })),
    Match.orElse(() => ({ reason: "unknown" as const })),
  );
  return new LegacyExperimentalStackRestartError({
    ...classification,
    message: error.message,
    cause: error,
  });
};

const catchStackError = <A, R>(
  effect: Effect.Effect<A, import("@supabase/stack/effect").StackError, R>,
) => effect.pipe(Effect.catchIf(isStackError, (error) => Effect.fail(mapStackError(error))));

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
    for (const [name, endpoint] of endpoints)
      if (endpoint !== undefined) lines.push(`  ${name}: ${endpoint.url}`);
  }
  const dormant = status.capabilities.filter(({ state }) => state === "dormant");
  if (dormant.length > 0)
    lines.push(`Dormant capabilities: ${dormant.map(({ name }) => name).join(", ")}`);
  return `${lines.join("\n")}\n`;
};

export const legacyExperimentalStackRestart = Effect.fn("legacy.experimental.stack.restart")(
  function* (flags: LegacyExperimentalStackRestartFlags) {
    const output = yield* Output;
    const settings = yield* LegacyCliSettings;
    const legacyOutput = yield* Effect.serviceOption(LegacyOutputFlag);
    if (Option.isSome(legacyOutput) && Option.isSome(legacyOutput.value))
      return yield* new LegacyExperimentalStackRestartError({
        reason: "flags",
        message: "The legacy -o/--output flag is not supported here; use --output-format json.",
      });
    yield* validateFlags(flags);
    const api = yield* LegacyExperimentalStackApi;
    const stackId = Option.getOrUndefined(flags.stackId);
    const stackName = Option.getOrUndefined(flags.stack);
    const target = yield* stackId !== undefined
      ? Effect.gen(function* () {
          const id = stackId;
          if (!isStackId(id))
            return yield* new LegacyExperimentalStackRestartError({
              reason: "flags",
              message: "--stack-id must be a lowercase SHA-256 stack id",
            });
          const inspection = yield* catchStackError(api.inspectStack(id));
          return { id, projectRoot: inspection.descriptor.projectRoot };
        })
      : Effect.gen(function* () {
          const found = yield* catchStackError(
            api.findStack({
              projectRoot: settings.workdir,
              ...(stackName === undefined ? {} : { name: stackName }),
            }),
          );
          if (Option.isNone(found))
            return yield* new LegacyExperimentalStackRestartError({
              reason: "not-found",
              message: "No managed stack exists for the selected project.",
              suggestion: "Run supabase experimental stack start first.",
            });
          return { id: found.value.id, projectRoot: found.value.projectRoot };
        });
    const config = yield* legacyLoadStackConfig(target.projectRoot).pipe(
      Effect.mapError(
        (error) =>
          new LegacyExperimentalStackRestartError({
            reason: "invalid-config",
            message: error.message,
            cause: error,
          }),
      ),
    );
    const stack = yield* catchStackError(api.openStack(target.id));
    const task = yield* output.task("Preparing local Supabase stack...");
    yield* catchStackError(stack.prepare({ config })).pipe(
      Effect.tapError((error) => task.fail(error.message)),
    );
    yield* task.message("Restarting local Supabase stack...");
    yield* catchStackError(stack.stop()).pipe(Effect.tapError((error) => task.fail(error.message)));
    const status = yield* catchStackError(stack.start({ config })).pipe(
      Effect.tapError((error) => task.fail(error.message)),
      Effect.tap(() => task.clear()),
    );
    if (output.format === "text") yield* output.raw(renderStatus(status));
    else yield* output.success("", statusPayload(status));
    return status;
  },
);
