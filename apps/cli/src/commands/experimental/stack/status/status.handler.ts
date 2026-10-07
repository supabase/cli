import { endpointReports } from "../stack-endpoints.format.ts";
import { Effect, Option, Path } from "effect";
import type { Observation, PlannedInstance, ServiceCreation, Stack } from "@supabase/stack/effect";
import type { StackCredentials, StackError } from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { loadStackConfig } from "../../../../command-internal/stack-config.ts";
import { withProjectFunctionsEnv } from "../../../../command-internal/stack-functions-env.ts";
import { bold, gray, green, red, yellow } from "../../../../command-internal/colors.ts";
import {
  connectionEnv,
  renderStackSummary,
  serviceState,
  stackConnections,
  type StackServiceState,
  stackEndpoints,
  summaryCredentials,
} from "../stack-summary.ts";
import {
  StackApi,
  StackTargetError,
  StackTargetResolver,
  rejectStackOutput,
  validateStackTarget,
} from "../stack.shared.ts";
import type { StackStatusFlags } from "./status.command.ts";
import { StackCommandStatusError } from "./status.errors.ts";
import { encodeStackEnv, stackEnvOverrides, stackEnvValues } from "./status.env.ts";

type StackService = Effect.Success<ReturnType<Stack["services"]["get"]>>;
type EndpointReport = {
  readonly protocol: "tcp" | "http";
  readonly address: string;
  readonly port: number;
  readonly url: string;
};
type ServiceReport = {
  readonly id: string;
  readonly service: ServiceCreation["service"];
  readonly state: StackServiceState;
  readonly lifecycle: Observation["lifecycle"] | null;
  readonly health: Observation["health"] | null;
  readonly endpoints: Readonly<Record<string, EndpointReport>>;
  readonly error?: string;
};
type ObservedService = {
  readonly instance: StackService;
  readonly observation: Observation | undefined;
  readonly error?: StackError;
};
type StackReport = {
  readonly identity: {
    readonly id: string;
    readonly name: string;
    readonly project_root: string;
    readonly branch_context: string;
  };
  readonly runtime: "native" | "docker" | "podman";
  readonly owner: "reachable" | "unavailable";
  readonly lifecycle: Observation["lifecycle"] | null;
  readonly readiness: "unavailable" | "starting" | "sleeping" | "stopped" | "ready" | "unhealthy";
  readonly composition: {
    readonly members: ReadonlyArray<{
      readonly id: string;
      readonly service: ServiceCreation["service"] | "unknown";
      readonly activation: string;
      readonly state: ServiceReport["state"];
      readonly lifecycle: ServiceReport["lifecycle"];
      readonly health: ServiceReport["health"];
    }>;
  };
  readonly services: ReadonlyArray<ServiceReport>;
  readonly endpoints: Readonly<Record<string, EndpointReport>>;
  readonly config_drift: {
    readonly status: "unchanged" | "changed" | "unavailable";
    readonly message: string;
    readonly paths?: ReadonlyArray<string>;
  };
  /** The `status --env` connection map, degrading to what's available when credentials or the owner are unreachable. */
  readonly env: Readonly<Record<string, string>>;
};

const mapTargetError = (error: StackTargetError) =>
  new StackCommandStatusError({
    reason: error.reason,
    message: error.message,
    ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
    cause: error,
  });

const isStateOperation = (operation: string) =>
  operation === "open" || operation === "discover" || operation === "definition";

const mapStackError = (error: StackError) =>
  isStateOperation(error.operation)
    ? new StackCommandStatusError({
        reason: "invalid-config",
        message: error.message,
        suggestion: "Inspect the saved stack state under $SUPABASE_HOME/stacks.",
        cause: error,
      })
    : new StackCommandStatusError({
        reason: "stack",
        message: error.message,
        suggestion: "Retry the command and use --debug if the stack remains unavailable.",
        cause: error,
      });

const serviceReport = ({ instance, observation, error }: ObservedService): ServiceReport => ({
  id: instance.id,
  service: instance.service,
  state: serviceState(observation),
  lifecycle: observation?.lifecycle ?? null,
  health: observation?.health ?? null,
  endpoints: endpointReports(observation),
  ...(error === undefined && observation?.error === undefined
    ? {}
    : { error: error?.message ?? observation?.error?.message }),
});

const aggregateLifecycle = (
  reports: ReadonlyArray<ServiceReport>,
  owner: StackReport["owner"],
): StackReport["lifecycle"] => {
  if (owner === "unavailable" || reports.length === 0) return null;
  if (reports.some(({ state }) => state === "unavailable")) return null;
  if (reports.some(({ lifecycle }) => lifecycle === "starting")) return "starting";
  if (reports.some(({ lifecycle }) => lifecycle === "stopping")) return "stopping";
  if (reports.some(({ lifecycle }) => lifecycle === "running")) return "running";
  return "stopped";
};

const aggregateReadiness = (
  reports: ReadonlyArray<ServiceReport>,
  owner: StackReport["owner"],
): StackReport["readiness"] => {
  if (owner === "unavailable" || reports.length === 0) return "unavailable";
  if (reports.some(({ state }) => state === "unavailable")) return "unavailable";
  if (reports.some(({ state }) => state === "unhealthy" || state === "exited")) return "unhealthy";
  if (reports.some(({ state }) => state === "starting")) return "starting";
  if (reports.some(({ state }) => state === "sleeping")) return "sleeping";
  if (reports.every(({ state }) => state === "stopped")) return "stopped";
  if (reports.some(({ state }) => state === "stopped")) return "stopped";
  return reports.every(({ state, health }) => state === "running" && health === "healthy")
    ? "ready"
    : "starting";
};

const reportFor = (
  definition: {
    readonly id: string;
    readonly identity: {
      readonly projectRoot: string;
      readonly branchContext: string;
      readonly stackName: string;
    };
    readonly runtime: "native" | "docker" | "podman";
  },
  owner: StackReport["owner"],
  observed: ReadonlyArray<ObservedService>,
  members: ReadonlyArray<{ readonly id: string; readonly activation: string }>,
  configDrift: StackReport["config_drift"],
  env: StackReport["env"],
): StackReport => {
  const services = observed.map(serviceReport);
  const endpoints = stackEndpoints(
    observed.map(({ instance, observation }) => ({ service: instance.service, observation })),
  );
  return {
    identity: {
      id: definition.id,
      name: definition.identity.stackName,
      project_root: definition.identity.projectRoot,
      branch_context: definition.identity.branchContext,
    },
    runtime: definition.runtime,
    owner,
    lifecycle: aggregateLifecycle(services, owner),
    readiness: aggregateReadiness(services, owner),
    composition: {
      members: members.map((member) => {
        const service = services.find(({ id }) => id === member.id);
        return {
          id: member.id,
          service: service?.service ?? "unknown",
          activation: member.activation,
          state: service?.state ?? "unavailable",
          lifecycle: service?.lifecycle ?? null,
          health: service?.health ?? null,
        };
      }),
    },
    services,
    endpoints,
    config_drift: configDrift,
    env,
  };
};

const readinessColor = (readiness: StackReport["readiness"]) => {
  switch (readiness) {
    case "ready":
      return green(readiness, process.stdout);
    case "starting":
      return yellow(readiness, process.stdout);
    case "unhealthy":
      return red(readiness, process.stdout);
    case "sleeping":
    case "stopped":
    case "unavailable":
      return gray(readiness, process.stdout);
  }
};

const renderDrift = (drift: StackReport["config_drift"]): ReadonlyArray<string> =>
  drift.status === "changed"
    ? [
        yellow(drift.message, process.stdout),
        ...(drift.paths ?? []).map((path) => `  ${path}`),
        gray(
          "Run supabase stack stop, then supabase stack start to apply the changes.",
          process.stdout,
        ),
      ]
    : [gray(drift.message, process.stdout)];

const render = (
  report: StackReport,
  observed: ReadonlyArray<ObservedService>,
  members: ReadonlyArray<{ readonly id: string; readonly activation: string }>,
  credentials: StackCredentials | undefined,
): string => {
  const activation = new Map(members.map((member) => [member.id, member.activation]));
  const header = `${bold(`Stack ${report.identity.name}`, process.stdout)} · ${readinessColor(report.readiness)} · ${report.runtime} · ${gray(report.identity.project_root, process.stdout)}`;
  const owner =
    report.owner === "unavailable"
      ? [gray("The stack owner is not running. Run supabase stack start.", process.stdout)]
      : [];
  const summary = renderStackSummary(
    observed.map(({ instance, observation, error }) => ({
      service: instance.service,
      observation,
      activation: activation.get(instance.id),
      error: error?.message ?? observation?.error?.message,
    })),
    credentials,
  );
  return `${[header, ...owner].join("\n")}\n\n${summary}\n${renderDrift(report.config_drift).join("\n")}\n`;
};

const findTarget = Effect.fn("experimental.stack.status.findTarget")(function* (
  projectRoot: string,
  name: string | undefined,
  id: string | undefined,
) {
  const resolver = yield* StackTargetResolver;
  const target = yield* resolver
    .resolve({
      projectRoot,
      ...(name === undefined ? {} : { name }),
      ...(id === undefined ? {} : { id }),
      runtime: "auto",
    })
    .pipe(Effect.mapError(mapTargetError));
  if (target.id === undefined || target.definition === undefined)
    return yield* new StackCommandStatusError({
      reason: "not-found",
      message: "No managed stack exists for the selected project.",
      suggestion: "Run supabase stack start first.",
    });
  return {
    ...target,
    id: target.id,
    definition: target.definition,
    owner: target.hostRunning ? ("reachable" as const) : ("unavailable" as const),
  };
});

const observe = Effect.fn("experimental.stack.status.observe")(function* (
  stack: Stack,
  owner: StackReport["owner"],
) {
  const instances = yield* stack.services.list.pipe(Effect.mapError(mapStackError));
  const composition = yield* stack.composition.describe.pipe(Effect.mapError(mapStackError));
  const observed = yield* Effect.forEach(instances, (instance): Effect.Effect<ObservedService> =>
    owner === "unavailable"
      ? Effect.succeed({ instance, observation: undefined })
      : instance.status.pipe(
          Effect.map((observation) => ({ instance, observation })),
          Effect.catchTag("StackError", (error) =>
            Effect.succeed({ instance, observation: undefined, error }),
          ),
        ),
  );
  return { observed, members: composition.members };
});

const driftFrom = (planned: ReadonlyArray<PlannedInstance>): StackReport["config_drift"] => {
  const paths = planned.flatMap((entry) =>
    !entry.member || entry.change === "unchanged"
      ? []
      : entry.paths.map((path) => `services.${entry.service}.${path}`),
  );
  return paths.length === 0
    ? {
        status: "unchanged",
        message: "Project configuration matches the saved composition members.",
      }
    : {
        status: "changed",
        message: `${paths.length} configured service ${paths.length === 1 ? "value differs" : "values differ"} from the saved stack.`,
        paths,
      };
};

const unavailableDrift = (message: string): StackReport["config_drift"] => ({
  status: "unavailable",
  message,
});

const configDrift = Effect.fn("experimental.stack.status.configDrift")(
  function* (stack: Stack, projectRoot: string, functionsIsMember: boolean) {
    const loaded = yield* loadStackConfig(projectRoot);
    const creations = yield* loaded.creations(stack.id);
    // Drift ignores non-members, so a Functions dotenv only matters when Functions is a member.
    const requested = functionsIsMember
      ? yield* Effect.forEach(creations, withProjectFunctionsEnv)
      : creations;
    return driftFrom(yield* stack.composition.plan(requested));
  },
  (effect) =>
    effect.pipe(
      Effect.catchTags({
        StackConfigError: (error) =>
          Effect.succeed(
            unavailableDrift(`Project configuration could not be compared: ${error.message}`),
          ),
        StackFunctionsEnvError: (error) =>
          Effect.succeed(
            unavailableDrift(`Project configuration could not be compared: ${error.message}`),
          ),
        StackError: (error) =>
          Effect.succeed(
            unavailableDrift(`Saved configuration could not be compared: ${error.message}`),
          ),
      }),
    ),
);

export const stackStatus = Effect.fn("experimental.stack.status")(function* (
  flags: StackStatusFlags,
) {
  const telemetryState = yield* TelemetryState;
  const body = Effect.gen(function* () {
    const output = yield* Output;
    const settings = yield* CommandSettings;
    const path = yield* Path.Path;
    const api = yield* StackApi;
    const outputFlag = yield* Effect.serviceOption(OutputFlag);
    yield* rejectStackOutput(outputFlag).pipe(
      Effect.mapError(
        (error) =>
          new StackCommandStatusError({
            reason: "flags",
            message: error.message,
            suggestion: "Use --output-format json, --output-format text, or --env.",
            cause: error,
          }),
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
    const target = yield* findTarget(
      settings.workdir,
      Option.getOrUndefined(flags.stack),
      Option.getOrUndefined(flags.stackId),
    );
    const locations = {
      stateRoot: path.join(settings.supabaseHome, "stacks"),
      cacheRoot: path.join(settings.supabaseHome, "cache", "stack"),
    };
    const stack = yield* api
      .open({ ...locations, id: target.id })
      .pipe(Effect.mapError(mapStackError));
    const observed = yield* observe(stack, target.owner);
    const memberIds = new Set(observed.members.map(({ id }) => id));
    const members = observed.observed.flatMap(({ instance, observation }) =>
      memberIds.has(instance.id) ? [{ service: instance.service, observation }] : [],
    );
    if (flags.env) {
      const database = observed.observed.find(
        ({ instance }) => memberIds.has(instance.id) && instance.service === "database",
      );
      const databaseObservation = database?.observation;
      if (
        target.owner === "unavailable" ||
        database === undefined ||
        databaseObservation === undefined ||
        databaseObservation.lifecycle !== "running"
      )
        return yield* new StackCommandStatusError({
          reason: "lifecycle",
          message: "The stack owner or primary database is unavailable for environment export.",
          suggestion: "Run supabase stack start first.",
        });
      if (databaseObservation.config.service !== "database")
        return yield* new StackCommandStatusError({
          reason: "lifecycle",
          message: "The primary database configuration is unavailable for environment export.",
          suggestion: "Run supabase stack start first.",
        });
      const identity = yield* stack.credentials.get.pipe(Effect.mapError(mapStackError));
      if (identity === undefined)
        return yield* new StackCommandStatusError({
          reason: "lifecycle",
          message: "The stack's active credentials are unavailable for environment export.",
          suggestion: "Run supabase stack start first.",
        });
      const connections = stackConnections(members);
      const values = stackEnvValues(connections, identity, envNames);
      if (output.format === "text") yield* output.raw(yield* encodeStackEnv(values));
      else yield* output.result(values);
      return;
    }
    const config = yield* configDrift(
      stack,
      target.definition.identity.projectRoot,
      observed.observed.some(
        ({ instance }) => memberIds.has(instance.id) && instance.service === "functions",
      ),
    );
    const credentials = yield* summaryCredentials(stack.credentials.get, output.warn);
    const connections = stackConnections(members);
    const report = reportFor(
      target.definition,
      target.owner,
      observed.observed,
      observed.members,
      config,
      connectionEnv(connections, credentials),
    );
    if (output.format === "text")
      yield* output.raw(render(report, observed.observed, observed.members, credentials));
    else yield* output.success("", report);
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
