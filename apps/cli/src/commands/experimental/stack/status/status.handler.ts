import { Effect, Match, Option } from "effect";
import {
  isStackError,
  type StackError,
  type StackInspection,
  type StackStatus,
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
import { loadStackConfig } from "../stack-config.ts";
import type { StackStatusFlags } from "./status.command.ts";
import { StackCommandStatusError } from "./status.errors.ts";
import { encodeStackEnv, stackEnvOverrides, stackEnvValues } from "./status.env.ts";

const mapTargetError = (error: StackTargetError) =>
  new StackCommandStatusError({
    reason: error.reason,
    message: error.message,
    ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
    cause: error,
  });

const classifyStackError = (error: StackError) =>
  Match.value(error).pipe(
    Match.tag("StackNotFoundError", () => ({
      reason: "not-found" as const,
      suggestion:
        "Choose an existing --stack-id, or run supabase stack start without --stack-id to create one.",
    })),
    Match.tag(
      "InvalidStackIdentityError",
      "InvalidProjectRootError",
      "InvalidStackConfigError",
      "StackVersionUnsupportedError",
      "StackStateInvalidError",
      "StackStateFormatUnsupportedError",
      "StackUpgradeRequiredError",
      "StackSecretMismatchError",
      "InvalidJwtSigningMaterialError",
      () => ({ reason: "invalid-config" as const }),
    ),
    Match.orElse(() => ({
      reason: "runtime" as const,
      suggestion: "Retry the command and use --debug if the stack state remains unavailable.",
    })),
  );

const mapStackError = (error: StackError) => {
  const classification = classifyStackError(error);
  return new StackCommandStatusError({
    ...classification,
    message: error.message,
    cause: error,
  });
};

const catchStackError = <A, R>(effect: Effect.Effect<A, StackError, R>) =>
  effect.pipe(Effect.catchIf(isStackError, (error) => Effect.fail(mapStackError(error))));

const readiness = (status: StackStatus | undefined): string => {
  if (status === undefined) return "unknown";
  if (status.lifecycle !== "running") return status.lifecycle;
  if (status.capabilities.some(({ state }) => state === "failed")) return "degraded";
  if (status.capabilities.some(({ state }) => state === "starting")) return "starting";
  if (status.capabilities.some(({ state }) => state === "stopped")) return "stopped";
  if (status.capabilities.some(({ state }) => state === "dormant")) return "dormant";
  return "ready";
};

const configUnavailableWarning =
  "Project configuration could not be loaded; fix it before checking drift.";

const payload = (inspection: StackInspection, configWarning?: string) => ({
  identity: {
    id: inspection.descriptor.id,
    name: inspection.descriptor.name,
    project_root: inspection.descriptor.projectRoot,
    branch_context: inspection.descriptor.branchContext,
  },
  runtime: inspection.descriptor.runtime,
  owner: inspection.owner,
  lifecycle: inspection.status?.lifecycle ?? null,
  desired_lifecycle: inspection.status?.desiredLifecycle ?? inspection.descriptor.desiredLifecycle,
  readiness: readiness(inspection.status),
  ...(inspection.status === undefined ? {} : { endpoints: inspection.status.endpoints }),
  ...(inspection.status === undefined ? {} : { capabilities: inspection.status.capabilities }),
  config_drift:
    inspection.configDrift ??
    ({
      status: "unavailable",
      message: configWarning ?? "Configuration was not compared.",
    } as const),
});

const comparedInspection = (
  inspection: StackInspection,
): {
  readonly inspection: StackInspection;
  readonly warning?: string;
} => ({ inspection });

const render = (inspection: StackInspection, configWarning?: string): string => {
  const descriptor = inspection.descriptor;
  const lines = [
    `Stack ${descriptor.name} (${descriptor.id})`,
    `Project: ${descriptor.projectRoot}`,
    `Branch: ${descriptor.branchContext}`,
    `Runtime: ${descriptor.runtime.kind}`,
    `Owner: ${inspection.owner}`,
    `Lifecycle: ${inspection.status?.lifecycle ?? "unavailable"}`,
    `Desired lifecycle: ${inspection.status?.desiredLifecycle ?? descriptor.desiredLifecycle}`,
    `Readiness: ${readiness(inspection.status)}`,
  ];
  if (inspection.status !== undefined) {
    const endpoints = Object.entries(inspection.status.endpoints);
    if (endpoints.length > 0) {
      lines.push("Endpoints:");
      for (const [name, endpoint] of endpoints)
        if (endpoint !== undefined) lines.push(`  ${name}: ${endpoint.url}`);
    }
  }
  const drift = inspection.configDrift;
  lines.push(`Config drift: ${drift?.status ?? "unavailable"}`);
  if (drift !== undefined) for (const path of drift.paths) lines.push(`  ${path}`);
  if (configWarning !== undefined) lines.push(`Config warning: ${configWarning}`);
  return `${lines.join("\n")}\n`;
};

const findDescriptor = (projectRoot: string, name: string | undefined, id: string | undefined) =>
  Effect.gen(function* () {
    const api = yield* StackApi;
    if (id !== undefined) {
      const validId = yield* validateStackId(id).pipe(Effect.mapError(mapTargetError));
      const inspection = yield* catchStackError(api.inspectStack(validId));
      return {
        descriptor: inspection.descriptor,
        id: validId,
        projectRoot: inspection.descriptor.projectRoot,
        inspection,
      };
    }
    const found = yield* catchStackError(
      api.findStack({ projectRoot, ...(name === undefined ? {} : { name }) }),
    );
    if (Option.isNone(found))
      return yield* new StackCommandStatusError({
        reason: "not-found",
        message: "No managed stack exists for the selected project.",
        suggestion: "Run supabase stack start first.",
      });
    return { descriptor: found.value, id: found.value.id, projectRoot: found.value.projectRoot };
  });

export const stackStatus = Effect.fn("experimental.stack.status")(function* (
  flags: StackStatusFlags,
) {
  const telemetryState = yield* TelemetryState;
  const body = Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const outputFlag = yield* Effect.serviceOption(OutputFlag);
    yield* rejectStackOutput(outputFlag).pipe(
      Effect.mapError((error) =>
        Option.isSome(outputFlag) && Option.getOrUndefined(outputFlag.value) === "env"
          ? new StackCommandStatusError({
              reason: "flags",
              message: error.message,
              suggestion:
                "Use --env to export connection variables; add --output-format json for a variable map.",
              cause: error,
            })
          : mapTargetError(error),
      ),
    );
    yield* validateStackTarget({
      stack: Option.getOrUndefined(flags.stack),
      stackId: Option.getOrUndefined(flags.stackId),
    }).pipe(Effect.mapError(mapTargetError));
    if (!flags.env && flags.overrideName.length > 0)
      return yield* new StackCommandStatusError({
        reason: "flags",
        message: "--override-name requires --env.",
      });
    const envNames = yield* stackEnvOverrides(flags.overrideName);
    const target = yield* findDescriptor(
      settings.workdir,
      Option.getOrUndefined(flags.stack),
      Option.getOrUndefined(flags.stackId),
    );
    const api = yield* StackApi;
    if (flags.env) {
      const stack = yield* catchStackError(api.openStack(target.id));
      const status = yield* catchStackError(stack.status());
      if (status.lifecycle !== "running")
        return yield* new StackCommandStatusError({
          reason: "runtime",
          message: "The stack must be running to export connection variables.",
          suggestion: "Run supabase stack start first.",
        });
      const credentials = yield* catchStackError(stack.credentials());
      const values = stackEnvValues(status, credentials, envNames);
      if (output.format === "text") yield* output.raw(yield* encodeStackEnv(values));
      else yield* output.result(values);
      return target.inspection;
    }
    const loaded = yield* loadStackConfig(target.projectRoot).pipe(
      Effect.map((config) => ({ config, warning: undefined })),
      Effect.catchTag("StackConfigError", () =>
        Effect.succeed({ config: undefined, warning: configUnavailableWarning }),
      ),
    );
    const comparison =
      loaded.config === undefined
        ? target.inspection === undefined
          ? yield* catchStackError(api.inspectStack(target.id)).pipe(Effect.map(comparedInspection))
          : { inspection: target.inspection }
        : yield* api.inspectStack(target.id, { config: loaded.config }).pipe(
            Effect.map(comparedInspection),
            Effect.catchTags({
              InvalidStackConfigError: () =>
                Effect.succeed({ inspection: undefined, warning: configUnavailableWarning }),
              StackVersionUnsupportedError: () =>
                Effect.succeed({ inspection: undefined, warning: configUnavailableWarning }),
            }),
            catchStackError,
          );
    const inspection =
      comparison.inspection === undefined
        ? (target.inspection ?? (yield* catchStackError(api.inspectStack(target.id))))
        : comparison.inspection;
    const inspectionWarning = loaded.warning ?? comparison.warning;
    if (output.format === "text") yield* output.raw(render(inspection, inspectionWarning));
    else yield* output.success("", payload(inspection, inspectionWarning));
    return inspection;
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
