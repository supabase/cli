import { BunHttpClient, BunServices } from "@effect/platform-bun";
import * as Stack from "@supabase/stack/effect";
import { Effect, FileSystem, Layer } from "effect";
import { homedir } from "node:os";
import { RuntimeInfo } from "../src/shared/runtime/runtime-info.service.ts";
import { loadStackConfig } from "../src/command-internal/stack-config.ts";
import { readStackFunctionsEnv } from "../src/command-internal/stack-functions-env.ts";
import { startupTrace } from "../src/command-internal/startup-trace.ts";

const expectedServices = [
  "analytics",
  "auth",
  "database",
  "functions",
  "mail",
  "pgmeta",
  "realtime",
  "rest",
  "storage",
  "studio",
  "vector",
] as const;
type CompositionMember = {
  readonly id: string;
  readonly service: string;
  readonly status: Effect.Effect<Stack.Observation, Stack.StackError>;
};

const args = new Map<string, string>();
for (let index = 0; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  if (key?.startsWith("--")) {
    const value = process.argv[index + 1];
    if (value !== undefined && !value.startsWith("--")) args.set(key, value);
  }
}

const required = (name: string): string => {
  const value = args.get(name);
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
};

const action = required("--action");
const runtime = required("--runtime");
const projectRoot = required("--project");
const stateRoot = required("--state-root");
const cacheRoot = required("--cache-root");
const mode = args.get("--mode") ?? "default";
const stackId = args.get("--stack-id");

if (action !== "start" && action !== "stop" && action !== "destroy") {
  throw new Error(`unsupported action ${action}`);
}
if (runtime !== "native" && runtime !== "docker")
  throw new Error(`unsupported runtime ${runtime}`);
if (mode !== "default" && mode !== "eager")
  throw new Error(`unsupported mode ${mode}`);
if (action !== "start" && stackId === undefined)
  throw new Error(`${action} requires --stack-id`);

const elapsed = (started: number) =>
  Number((performance.now() - started).toFixed(2));
const program = Effect.gen(function* () {
  const timings: Record<string, number> = {};
  const configStarted = performance.now();
  if (action === "start")
    yield* startupTrace("api.config.begin", { runtime, project: projectRoot });
  const config =
    action === "start" ? yield* loadStackConfig(projectRoot) : undefined;
  const identity = config === undefined ? undefined : yield* config.identity;
  if (config !== undefined) timings.config_load_ms = elapsed(configStarted);
  if (config !== undefined)
    yield* startupTrace("api.config.end", {
      project: projectRoot,
      elapsed_ms: timings.config_load_ms,
    });
  let stack: Stack.Stack;
  if (action === "start" && stackId === undefined) {
    const started = performance.now();
    yield* startupTrace("api.create.begin", { runtime, project: projectRoot });
    stack = yield* Stack.create({ projectRoot, stateRoot, cacheRoot, runtime });
    timings.create_ms = elapsed(started);
    yield* startupTrace("api.create.end", {
      identity: stack.id,
      runtime,
      elapsed_ms: timings.create_ms,
    });
  } else {
    const started = performance.now();
    stack = yield* Stack.open({
      id: stackId ?? "",
      stateRoot,
      cacheRoot,
      startOwner: true,
    });
    timings.open_ms = elapsed(started);
    yield* startupTrace("api.open.end", {
      identity: stack.id,
      runtime,
      elapsed_ms: timings.open_ms,
    });
  }

  if (action === "stop") {
    const started = performance.now();
    yield* stack.stop;
    timings.stop_ms = elapsed(started);
    yield* Effect.sync(() =>
      console.log(JSON.stringify({ action, stack_id: stack.id, timings })),
    );
    return;
  }
  if (action === "destroy") {
    const started = performance.now();
    yield* stack.destroy;
    timings.destroy_ms = elapsed(started);
    yield* Effect.sync(() =>
      console.log(JSON.stringify({ action, stack_id: stack.id, timings })),
    );
    return;
  }

  const compositionStarted = performance.now();
  let members: ReadonlyArray<CompositionMember>;
  if (stackId === undefined) {
    yield* startupTrace("api.composition.begin", { identity: stack.id });
    if (config === undefined || identity === undefined)
      return yield* Effect.die("Stack config was not loaded");
    const creations = yield* config.creations(stack.id);
    const withFunctionsEnv = yield* Effect.forEach(creations, (creation) =>
      Effect.gen(function* () {
        if (creation.service !== "functions") return creation;
        const env = yield* readStackFunctionsEnv(
          `${creation.config.functionsRoot}/.env`,
          true,
        );
        return {
          ...creation,
          config: {
            ...creation.config,
            env: { ...env, ...creation.config.env },
          },
        };
      }),
    );
    const fs = yield* FileSystem.FileSystem;
    yield* Effect.forEach(
      withFunctionsEnv,
      (creation) =>
        creation.service === "storage"
          ? fs.makeDirectory(creation.config.filePath, { recursive: true })
          : creation.service === "functions"
            ? fs.makeDirectory(creation.config.functionsRoot, {
                recursive: true,
              })
            : Effect.void,
      { discard: true },
    );
    members = yield* stack.composition.supabase(withFunctionsEnv, { identity });
    const configured = yield* stack.composition.describe;
    yield* stack.composition.configure({
      ...configured,
      members: configured.members.map(({ id }) => {
        const member = members.find((item) => item.id === id);
        const eager = mode === "eager" || member?.service === "database";
        return {
          id,
          activation: eager ? ("eager" as const) : ("lazy" as const),
          ...(eager || member?.service === "functions"
            ? {}
            : { idleMillis: 60_000 }),
        };
      }),
    });
    yield* startupTrace("api.composition.end", {
      identity: stack.id,
      member_count: members.length,
      members: members.map(({ id, service }) => ({ id, service })),
    });
  } else {
    const configured = yield* stack.composition.describe;
    members = yield* Effect.forEach(configured.members, ({ id }) =>
      stack.services.get(id),
    );
  }
  timings.composition_ms = elapsed(compositionStarted);
  const startStarted = performance.now();
  yield* startupTrace("api.start.begin", { identity: stack.id, mode });
  yield* stack.composition.start;
  timings.start_ms = elapsed(startStarted);
  yield* startupTrace("api.start.end", {
    identity: stack.id,
    mode,
    elapsed_ms: timings.start_ms,
  });
  const readinessStarted = performance.now();
  const statuses = yield* Effect.forEach(members, (member) =>
    member.status.pipe(
      Effect.map((status) => ({ ...status, service: member.service })),
    ),
  );
  timings.readiness_ms = elapsed(readinessStarted);
  const names = statuses.map((status) => status.service).sort();
  const selectedServicesMatch =
    expectedServices.every((name) => names.includes(name)) &&
    names.length === expectedServices.length;
  const ready =
    mode === "eager"
      ? statuses.every((status) => status.lifecycle === "running")
      : statuses.every((status) =>
          status.service === "database"
            ? status.lifecycle === "running"
            : status.wakeEnabled,
        );
  yield* Effect.sync(() =>
    console.log(
      JSON.stringify({
        action,
        stack_id: stack.id,
        runtime,
        mode,
        timings,
        expected_services: expectedServices,
        services: statuses.map(({ service, lifecycle, wakeEnabled }) => ({
          service,
          lifecycle,
          wake_enabled: wakeEnabled,
        })),
        selected_services_match: selectedServicesMatch,
        ready,
        cli_catalog_setup:
          "omitted: the CLI applies auth/storage/realtime catalog overlays, migrations, seeds, and project-specific settings before composition start",
      }),
    ),
  );
  if (!selectedServicesMatch || !ready)
    yield* Effect.fail(
      new Error("API stack did not reach expected service state"),
    );
});
const runtimeInfo = Layer.succeed(RuntimeInfo, {
  cwd: process.cwd(),
  platform: process.platform,
  arch: process.arch,
  homeDir: homedir(),
  execPath: process.execPath,
  pid: process.pid,
});
Effect.runPromise(
  program.pipe(
    Effect.provide(
      Layer.mergeAll(BunServices.layer, BunHttpClient.layer, runtimeInfo),
    ),
  ),
).catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
