import { Effect, Option } from "effect";
import { loadCliConfig } from "@supabase/config/effect";
import {
  connectLayer,
  fillServiceVersionManifest,
  resolveStackSummary,
  Stack,
  type StackSummary,
} from "@supabase/stack/effect";
import { CliSettings } from "../../config/cli-settings.service.ts";
import { ProjectHome } from "../../config/project-home.service.ts";
import { resolveServiceVersionContext } from "../../config/service-version-resolution.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import type { StatusFlags } from "./status.command.ts";
import { managedPortIntents } from "../../config/managed-port-intents.ts";
import { isExcludedStackService, toStartStackConfig } from "../../config/stack-config.ts";
import { formatPortDriftWarning } from "../../stack/port-drift.ts";

function formatServiceStateLine(service: {
  readonly name: string;
  readonly status: string;
  readonly error: string | null;
}) {
  return service.error == null
    ? `${service.name}: ${service.status}`
    : `${service.name}: ${service.status} (${service.error})`;
}

function formatPortsLine(ports: { readonly apiPort: number; readonly dbPort: number }) {
  return `Ports: API ${ports.apiPort}, DB ${ports.dbPort}`;
}

const resolveConfiguredSummary = Effect.fnUntraced(function* (input: {
  readonly cacheRoot: string;
  readonly projectDir: string;
  readonly cwd: string;
  readonly name: string;
}) {
  const current = yield* resolveStackSummary(input);
  const loaded = yield* loadCliConfig(input.projectDir);
  const excluded = (current.launch.excludedServices ?? []).filter(isExcludedStackService);
  const mode = current.launch.mode;
  return yield* resolveStackSummary({
    ...input,
    portDocument: managedPortIntents(toStartStackConfig(excluded, mode), loaded ?? undefined),
  });
});

const renderPortDrift = Effect.fnUntraced(function* (drift: NonNullable<StackSummary["drift"]>) {
  const message = formatPortDriftWarning(drift);
  if (message === undefined) return;
  const output = yield* Output;
  yield* output.warn(message);
});

const renderUpdateStatus = Effect.fnUntraced(function* (
  updates: ReadonlyArray<{
    readonly service: string;
    readonly pinnedVersion: string;
    readonly availableVersion: string;
  }>,
) {
  const output = yield* Output;

  if (updates.length === 0) {
    yield* output.info("Pinned stack versions are up to date.");
    return;
  }

  yield* output.warn("Updates are available for this stack.");
  for (const updateEntry of updates) {
    yield* output.info(
      `${updateEntry.service}: ${updateEntry.pinnedVersion} -> ${updateEntry.availableVersion}`,
    );
  }
  yield* output.info("Run `supabase stack update` to adopt these pinned versions.");
});

export const status = Effect.fnUntraced(function* (_flags: StatusFlags) {
  const output = yield* Output;
  const cliSettings = yield* CliSettings;
  const projectHome = yield* ProjectHome;
  const runtimeInfo = yield* RuntimeInfo;

  yield* output.intro("Show local Supabase stack status");

  const layer = yield* connectLayer({
    cwd: runtimeInfo.cwd,
    cacheRoot: cliSettings.supabaseHome,
    projectDir: projectHome.projectRoot,
    name: _flags.stack,
  }).pipe(
    Effect.map(Option.some),
    Effect.catchTag("NoRunningStackError", () => Effect.succeed(Option.none())),
  );

  if (Option.isNone(layer)) {
    const summary = yield* resolveConfiguredSummary({
      cacheRoot: cliSettings.supabaseHome,
      projectDir: projectHome.projectRoot,
      cwd: runtimeInfo.cwd,
      name: _flags.stack,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchTag("NoRunningStackError", () => Effect.succeed(Option.none())),
    );

    if (Option.isNone(summary)) {
      const message = "No local Supabase stack is running for this project.";
      if (output.format === "text") {
        yield* output.outro(message);
        return;
      }

      yield* output.success(message, { stack: _flags.stack, running: false });
      return;
    }

    const message = "Local Supabase stack is stopped.";
    const serviceVersionContext = yield* resolveServiceVersionContext(
      [],
      fillServiceVersionManifest(summary.value.versions),
    );
    const data = {
      stack: summary.value.name,
      running: false,
      ports: summary.value.ports,
      versions: summary.value.versions,
      up_to_date: serviceVersionContext.availableUpdates.length === 0,
      available_updates: serviceVersionContext.availableUpdates.map((updateEntry) => ({
        service: updateEntry.service,
        pinned_version: updateEntry.pinnedVersion,
        available_version: updateEntry.availableVersion,
      })),
    };

    if (output.format !== "text") {
      yield* output.success(message, data);
      return;
    }

    yield* output.info(message);
    yield* output.info(`Stack: ${summary.value.name}`);
    yield* output.info(formatPortsLine(summary.value.ports));
    for (const [name, version] of Object.entries(summary.value.versions).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      yield* output.info(`${name} version: ${version}`);
    }
    yield* renderUpdateStatus(serviceVersionContext.availableUpdates);
    yield* output.outro(`Local Supabase stack ${summary.value.name} is stopped.`);
    return;
  }

  const summary = yield* resolveConfiguredSummary({
    cacheRoot: cliSettings.supabaseHome,
    projectDir: projectHome.projectRoot,
    cwd: runtimeInfo.cwd,
    name: _flags.stack,
  });

  const stack = yield* Effect.provide(Stack, layer.value);
  const [info, services] = yield* Effect.all([stack.getInfo(), stack.getAllStates()]);
  const serviceVersionContext = yield* resolveServiceVersionContext(
    [],
    fillServiceVersionManifest(summary.versions),
  );
  const sortedServices = [...services].sort((a, b) => a.name.localeCompare(b.name));
  const allReady = services.every((service) =>
    ["Running", "Healthy", "Dormant"].includes(service.status),
  );
  const message = allReady
    ? "Local Supabase stack is running."
    : "Local Supabase stack is running, but some services are not ready.";
  yield* renderPortDrift(summary.drift ?? []);
  const data = {
    stack: summary.name,
    running: true,
    api_url: info.url,
    db_url: info.dbUrl,
    publishable_key: info.publishableKey,
    secret_key: info.secretKey,
    service_endpoints: info.serviceEndpoints,
    versions: summary.versions,
    up_to_date: serviceVersionContext.availableUpdates.length === 0,
    available_updates: serviceVersionContext.availableUpdates.map((updateEntry) => ({
      service: updateEntry.service,
      pinned_version: updateEntry.pinnedVersion,
      available_version: updateEntry.availableVersion,
    })),
    services: sortedServices.map((service) => ({
      name: service.name,
      status: service.status,
      pid: service.pid,
      exit_code: service.exitCode,
      restart_count: service.restartCount,
      started_at: service.startedAt,
      error: service.error,
    })),
  };

  if (output.format !== "text") {
    yield* output.success(message, data);
    return;
  }

  if (allReady) {
    yield* output.success(message);
  } else {
    yield* output.warn(message);
  }

  yield* output.info(`Stack: ${summary.name}`);
  yield* output.info(`API URL: ${info.url}`);
  yield* output.info(`DB URL: ${info.dbUrl}`);
  yield* output.info(`Publishable key: ${info.publishableKey}`);
  yield* output.info(`Secret key: ${info.secretKey}`);
  for (const [name, version] of Object.entries(summary.versions).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    yield* output.info(`${name} version: ${version}`);
  }
  yield* renderUpdateStatus(serviceVersionContext.availableUpdates);
  for (const [name, endpoint] of Object.entries(info.serviceEndpoints).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    yield* output.info(`${name}: ${endpoint}`);
  }

  for (const service of sortedServices) {
    yield* output.info(formatServiceStateLine(service));
  }
});
