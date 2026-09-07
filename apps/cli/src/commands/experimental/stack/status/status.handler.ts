import { Effect, Match, Option } from "effect";
import {
  isStackError,
  isStackId,
  type StackError,
  type StackInspection,
  type StackStatus,
} from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyOutputFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyCliSettings } from "../../../../config/legacy-cli-settings.service.ts";
import { LegacyExperimentalStackApi } from "../stack.shared.ts";
import { legacyLoadStackConfig } from "../stack-config.ts";
import type { LegacyExperimentalStackStatusFlags } from "./status.command.ts";
import { LegacyExperimentalStackStatusError } from "./status.errors.ts";

const validateFlags = (flags: LegacyExperimentalStackStatusFlags) =>
  Option.isSome(flags.stack) && Option.isSome(flags.stackId)
    ? Effect.fail(
        new LegacyExperimentalStackStatusError({
          reason: "flags",
          message: "--stack and --stack-id cannot be used together",
        }),
      )
    : Effect.void;

const classifyStackError = (error: StackError) =>
  Match.value(error).pipe(
    Match.tag("StackNotFoundError", () => ({
      reason: "not-found" as const,
      suggestion: "Run supabase experimental stack start first.",
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
  return new LegacyExperimentalStackStatusError({
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
  if (status.capabilities.some(({ state }) => state === "failed")) return "failed";
  if (status.capabilities.some(({ state }) => state === "starting")) return "starting";
  if (status.capabilities.some(({ state }) => state === "dormant")) return "dormant";
  return "ready";
};

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
    `Desired lifecycle: ${descriptor.desiredLifecycle}`,
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
    const api = yield* LegacyExperimentalStackApi;
    if (id !== undefined) {
      if (!isStackId(id))
        return yield* new LegacyExperimentalStackStatusError({
          reason: "flags",
          message: "--stack-id must be a lowercase SHA-256 stack id",
        });
      const inspection = yield* catchStackError(api.inspectStack(id));
      return {
        descriptor: inspection.descriptor,
        id,
        projectRoot: inspection.descriptor.projectRoot,
        inspection,
      };
    }
    const found = yield* catchStackError(
      api.findStack({ projectRoot, ...(name === undefined ? {} : { name }) }),
    );
    if (Option.isNone(found))
      return yield* new LegacyExperimentalStackStatusError({
        reason: "not-found",
        message: "No managed stack exists for the selected project.",
        suggestion: "Run supabase experimental stack start first.",
      });
    return { descriptor: found.value, id: found.value.id, projectRoot: found.value.projectRoot };
  });

export const legacyExperimentalStackStatus = Effect.fn("legacy.experimental.stack.status")(
  function* (flags: LegacyExperimentalStackStatusFlags) {
    const output = yield* Output;
    const settings = yield* LegacyCliSettings;
    const legacyOutput = yield* Effect.serviceOption(LegacyOutputFlag);
    if (Option.isSome(legacyOutput) && Option.isSome(legacyOutput.value))
      return yield* new LegacyExperimentalStackStatusError({
        reason: "flags",
        message: "The legacy -o/--output flag is not supported here; use --output-format json.",
        suggestion: "Use --output-format json or --output-format text.",
      });
    yield* validateFlags(flags);
    const target = yield* findDescriptor(
      settings.workdir,
      Option.getOrUndefined(flags.stack),
      Option.getOrUndefined(flags.stackId),
    );
    const api = yield* LegacyExperimentalStackApi;
    const loaded = yield* legacyLoadStackConfig(target.projectRoot).pipe(
      Effect.map((config) => ({ config, warning: undefined as string | undefined })),
      Effect.catchTag("LegacyStackConfigError", (error) =>
        Effect.succeed({ config: undefined, warning: error.message }),
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
              InvalidStackConfigError: (error) =>
                Effect.succeed({ inspection: undefined, warning: error.message }),
              StackVersionUnsupportedError: (error) =>
                Effect.succeed({ inspection: undefined, warning: error.message }),
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
  },
);
