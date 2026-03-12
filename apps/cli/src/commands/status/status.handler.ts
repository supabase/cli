import { Effect } from "effect";
import { connectLayer, Stack } from "@supabase/stack/internals";
import { CliConfig } from "../../config/cli-config.service.ts";
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

export const status = Effect.fnUntraced(function* (_flags: StatusFlags) {
  const output = yield* Output;
  const cliConfig = yield* CliConfig;
  const runtimeInfo = yield* RuntimeInfo;

  yield* output.intro("Show local Supabase stack status");

  const layer = yield* connectLayer({
    cwd: runtimeInfo.cwd,
    cacheRoot: cliConfig.supabaseHome,
  }).pipe(Effect.option);

  if (layer._tag === "None") {
    const message = "No local Supabase stack is running for this project.";
    if (output.format === "text") {
      yield* output.outro(message);
      return;
    }

    yield* output.success(message, { running: false });
    return;
  }

  const stack = yield* Effect.provide(Stack.asEffect(), layer.value);
  const [info, services] = yield* Effect.all([stack.getInfo(), stack.getAllStates()]);
  const sortedServices = [...services].sort((a, b) => a.name.localeCompare(b.name));
  const allReady = sortedServices.every((service) => READY_STATUSES.has(service.status));
  const message = allReady
    ? "Local Supabase stack is running."
    : "Local Supabase stack is running, but some services are not ready.";
  const data = {
    running: true,
    api_url: info.url,
    db_url: info.dbUrl,
    publishable_key: info.publishableKey,
    secret_key: info.secretKey,
    service_endpoints: info.serviceEndpoints,
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

  yield* output.info(`API URL: ${info.url}`);
  yield* output.info(`DB URL: ${info.dbUrl}`);
  yield* output.info(`Publishable key: ${info.publishableKey}`);
  yield* output.info(`Secret key: ${info.secretKey}`);
  for (const [name, endpoint] of Object.entries(info.serviceEndpoints).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    yield* output.info(`${name}: ${endpoint}`);
  }

  for (const service of sortedServices) {
    yield* output.info(formatServiceStateLine(service));
  }
});
