import { Effect, Option } from "effect";
import {
  connectLayer,
  fillServiceVersionManifest,
  resolveManagedStack,
  resolveStackSummary,
  StateManager,
  Stack,
} from "@supabase/stack/effect";
import { CliConfig } from "../../config/cli-config.service.ts";
import { ProjectHome } from "../../config/project-home.service.ts";
import { resolveServiceVersionContext } from "../../config/service-version-resolution.ts";
import { Output } from "../../output/output.service.ts";
import { RuntimeInfo } from "../../runtime/runtime-info.service.ts";
import type { StatusFlags } from "./status.command.ts";

const READY_STATUSES = new Set(["Healthy", "Running"]);

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
  const cliConfig = yield* CliConfig;
  const projectHome = yield* ProjectHome;
  const runtimeInfo = yield* RuntimeInfo;
  const stateManager = yield* StateManager;

  yield* output.intro("Show local Supabase stack status");

  const layer = yield* connectLayer({
    cwd: runtimeInfo.cwd,
    cacheRoot: cliConfig.supabaseHome,
    projectDir: projectHome.projectRoot,
    projectStateRoot: projectHome.projectHomeDir,
    name: _flags.stack,
  }).pipe(
    Effect.map(Option.some),
    Effect.catchTag("NoRunningStackError", () => Effect.succeed(Option.none())),
  );

  if (layer._tag === "None") {
    const summary = yield* resolveStackSummary({
      cacheRoot: cliConfig.supabaseHome,
      projectStateRoot: projectHome.projectHomeDir,
      name: _flags.stack,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchTag("NoRunningStackError", () => Effect.succeed(Option.none())),
    );

    if (summary._tag === "None") {
      const message = "No local Supabase stack is running for this project.";
      if (output.format === "text") {
        yield* output.outro(message);
        return;
      }

      yield* output.success(message, { stack: _flags.stack, running: false });
      return;
    }

    const message = "Local Supabase stack is stopped.";
    const serviceVersionContext = yield* resolveServiceVersionContext([], summary.value.versions);
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

  const managedStack = yield* resolveManagedStack({
    cwd: runtimeInfo.cwd,
    cacheRoot: cliConfig.supabaseHome,
    projectDir: projectHome.projectRoot,
    projectStateRoot: projectHome.projectHomeDir,
    name: _flags.stack,
  });

  const stack = yield* Effect.provide(Stack.asEffect(), layer.value);
  const [info, services] = yield* Effect.all([stack.getInfo(), stack.getAllStates()]);
  const existingMetadata = yield* stateManager.readMetadata(managedStack.state.name).pipe(
    Effect.map(Option.some),
    Effect.catchTag("StackMetadataNotFoundError", () => Effect.succeed(Option.none())),
  );
  const serviceVersionContext = yield* resolveServiceVersionContext(
    [],
    existingMetadata._tag === "Some"
      ? existingMetadata.value.services
      : fillServiceVersionManifest(managedStack.state.services),
  );
  const sortedServices = [...services].sort((a, b) => a.name.localeCompare(b.name));
  const allReady = sortedServices.every((service) => READY_STATUSES.has(service.status));
  const message = allReady
    ? "Local Supabase stack is running."
    : "Local Supabase stack is running, but some services are not ready.";
  const data = {
    stack: managedStack.state.name,
    running: true,
    api_url: info.url,
    db_url: info.dbUrl,
    publishable_key: info.publishableKey,
    secret_key: info.secretKey,
    service_endpoints: info.serviceEndpoints,
    versions: managedStack.state.services,
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

  yield* output.info(`Stack: ${managedStack.state.name}`);
  yield* output.info(`API URL: ${info.url}`);
  yield* output.info(`DB URL: ${info.dbUrl}`);
  yield* output.info(`Publishable key: ${info.publishableKey}`);
  yield* output.info(`Secret key: ${info.secretKey}`);
  for (const [name, version] of Object.entries(managedStack.state.services).sort(([a], [b]) =>
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
