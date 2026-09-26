import { endpointReports } from "../stack-endpoints.format.ts";
import { Effect, Option, Path, Redacted } from "effect";
import type { Observation, PlannedInstance, ServiceCreation, Stack } from "@supabase/stack/effect";
import type { StackError } from "@supabase/stack/effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { OutputFlag } from "../../../../command-internal/global-flags.ts";
import { CommandSettings } from "../../../../config/command-settings.service.ts";
import { TelemetryState } from "../../../../telemetry/telemetry-state.service.ts";
import { loadStackConfig } from "../../../../command-internal/stack-config.ts";
import { withProjectFunctionsEnv } from "../../../../command-internal/stack-functions-env.ts";
import { toPostgresURL } from "../../../../command-internal/postgres-url.ts";
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
  readonly state:
    | "unavailable"
    | "sleeping"
    | "starting"
    | "running"
    | "stopping"
    | "stopped"
    | "unhealthy"
    | "exited";
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
};

const mapTargetError = (error: StackTargetError) =>
  new StackCommandStatusError({
    reason: error.reason,
    message: error.message,
    ...(error.suggestion === undefined ? {} : { suggestion: error.suggestion }),
    cause: error,
  });

const mapStackError = (error: StackError) =>
  new StackCommandStatusError({
    reason:
      error.operation === "open" ||
      error.operation === "discover" ||
      error.operation === "definition"
        ? "invalid-config"
        : "runtime",
    message: error.message,
    suggestion:
      error.operation === "open" ||
      error.operation === "discover" ||
      error.operation === "definition"
        ? "Inspect the saved stack state under $SUPABASE_HOME/stacks."
        : "Retry the command and use --debug if the stack remains unavailable.",
    cause: error,
  });

const serviceState = (observation: Observation | undefined): ServiceReport["state"] => {
  if (observation === undefined) return "unavailable";
  if (observation.health === "unhealthy") return "unhealthy";
  if (observation.lifecycle === "stopped") {
    if (observation.error?.operation === "exit") return "exited";
    return observation.wakeEnabled ? "sleeping" : "stopped";
  }
  return observation.lifecycle;
};

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

const endpointFor = (
  services: ReadonlyArray<ServiceReport>,
  members: ReadonlyArray<{ readonly id: string }>,
  service: ServiceCreation["service"],
  endpoint: string,
) => {
  const memberIds = new Set(members.map(({ id }) => id));
  return services.find((entry) => memberIds.has(entry.id) && entry.service === service)?.endpoints[
    endpoint
  ];
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
): StackReport => {
  const services = observed.map(serviceReport);
  const endpoints = Object.fromEntries(
    services.flatMap((service) =>
      Object.entries(service.endpoints).map(([name, endpoint]) => [
        `${service.service}.${name}`,
        endpoint,
      ]),
    ),
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
  };
};

const render = (report: StackReport): string => {
  const lines = [
    `Stack ${report.identity.name} (${report.identity.id})`,
    `Project: ${report.identity.project_root}`,
    `Branch: ${report.identity.branch_context}`,
    `Runtime: ${report.runtime}`,
    `Owner: ${report.owner}`,
    `Lifecycle: ${report.lifecycle ?? "unavailable"}`,
    `Readiness: ${report.readiness}`,
    "Services:",
  ];
  const members = new Map(report.composition.members.map((member) => [member.id, member]));
  for (const service of report.services) {
    const details = [service.state, `lifecycle=${service.lifecycle ?? "unavailable"}`];
    const member = members.get(service.id);
    details.push(member === undefined ? "standalone" : `activation=${member.activation}`);
    if (service.health !== null) details.push(`health=${service.health}`);
    lines.push(`  ${service.service} (${service.id}): ${details.join(", ")}`);
    for (const [name, endpoint] of Object.entries(service.endpoints))
      lines.push(`    ${name}: ${endpoint.url}`);
    if (service.error !== undefined) lines.push(`    error: ${service.error}`);
  }
  lines.push(`Config drift: ${report.config_drift.status}`);
  lines.push(`  ${report.config_drift.message}`);
  for (const path of report.config_drift.paths ?? []) lines.push(`  ${path}`);
  return `${lines.join("\n")}\n`;
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

const observe = (stack: Stack, owner: StackReport["owner"]) =>
  Effect.gen(function* () {
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
        message: `${paths.length} configured service value${paths.length === 1 ? "" : "s"} differ from the saved stack.`,
        paths,
      };
};

const unavailableDrift = (message: string): StackReport["config_drift"] => ({
  status: "unavailable",
  message,
});

const configDrift = (stack: Stack, projectRoot: string, functionsIsMember: boolean) =>
  Effect.gen(function* () {
    const loaded = yield* loadStackConfig(projectRoot);
    const creations = yield* loaded.creations(stack.id);
    // Drift ignores non-members, so a Functions dotenv only matters when Functions is a member.
    const requested = functionsIsMember
      ? yield* Effect.forEach(creations, withProjectFunctionsEnv)
      : creations;
    return driftFrom(yield* stack.composition.plan(requested));
  }).pipe(
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
      const databaseConfig = databaseObservation.config;
      if (databaseConfig.service !== "database")
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
      const sql = databaseObservation.endpoints.find(({ name }) => name === "sql");
      const databaseUrl =
        sql === undefined
          ? undefined
          : toPostgresURL({
              host: sql.host,
              port: sql.port,
              user: "supabase_admin",
              password: Redacted.value(databaseConfig.config.databasePassword),
              database: "postgres",
            });
      const services = observed.observed.map(serviceReport);
      const endpoints = {
        ...(endpointFor(services, observed.members, "rest", "http") === undefined
          ? {}
          : { api: endpointFor(services, observed.members, "rest", "http") }),
        ...(endpointFor(services, observed.members, "studio", "http") === undefined
          ? {}
          : { studio: endpointFor(services, observed.members, "studio", "http") }),
        ...(endpointFor(services, observed.members, "mail", "http") === undefined
          ? {}
          : { mailUi: endpointFor(services, observed.members, "mail", "http") }),
      };
      const values = stackEnvValues(
        { endpoints, credentials: identity },
        databaseUrl === undefined ? {} : { databaseUrl },
        envNames,
      );
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
    const report = reportFor(
      target.definition,
      target.owner,
      observed.observed,
      observed.members,
      config,
    );
    if (output.format === "text") yield* output.raw(render(report));
    else yield* output.success("", report);
  });
  return yield* body.pipe(Effect.ensuring(telemetryState.flush));
});
