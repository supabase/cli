import { Stack } from "@supabase/stack/effect";
import { Effect, Fiber, Option, Stream } from "effect";
import { CliConfig } from "../config/cli-config.service.ts";
import { Output } from "../../shared/output/output.service.ts";

const DIAGNOSTIC_SERVICES = ["analytics", "vector"] as const;
const DIAGNOSTIC_LOG_LINES = 80;

function shouldInspectState(state: { readonly status: string }): boolean {
  return state.status !== "Healthy" && state.status !== "Stopped";
}

function formatState(state: {
  readonly name: string;
  readonly status: string;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly restartCount: number;
  readonly error: string | null;
}): string {
  const details = [
    `status=${state.status}`,
    state.pid == null ? undefined : `pid=${state.pid}`,
    state.exitCode == null ? undefined : `exitCode=${state.exitCode}`,
    state.restartCount === 0 ? undefined : `restarts=${state.restartCount}`,
    state.error == null ? undefined : `error=${state.error}`,
  ].filter((entry): entry is string => entry !== undefined);
  return `${state.name}: ${details.join(" ")}`;
}

const emitStartupDiagnostics = Effect.fnUntraced(function* (reason: string) {
  const output = yield* Output;
  const stack = yield* Stack;
  const states = yield* stack.getAllStates().pipe(Effect.catch(() => Effect.succeed([])));
  const stateNames = new Set(states.filter(shouldInspectState).map((state) => state.name));
  for (const service of DIAGNOSTIC_SERVICES) {
    stateNames.add(service);
  }

  if (stateNames.size === 0) {
    return;
  }

  yield* output.warn(`[debug] Stack startup diagnostics (${reason})`);
  for (const state of states.filter((entry) => stateNames.has(entry.name))) {
    yield* output.warn(`[debug] ${formatState(state)}`);
  }

  for (const service of [...stateNames].sort((a, b) => a.localeCompare(b))) {
    const history = yield* stack
      .logHistory(service, DIAGNOSTIC_LOG_LINES)
      .pipe(Effect.catch(() => Effect.succeed([])));
    if (history.length === 0) {
      yield* output.warn(`[debug] ${service}: no recent logs`);
      continue;
    }

    yield* output.warn(`[debug] ${service}: recent logs`);
    for (const entry of history) {
      yield* output.event({
        type: "log-entry",
        timestamp: new Date(entry.timestamp).toISOString(),
        service: entry.service,
        stream: entry.stream,
        line: entry.line,
        source: "history",
      });
    }
  }
});

export const startStackWithProgress = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const stack = yield* Stack;
  const cliConfig = yield* CliConfig;
  const debugEnabled = Option.isSome(cliConfig.debug) && cliConfig.debug.value === "1";

  const initialStates = yield* stack.getAllStates();
  const stateNames = new Set(initialStates.map((state) => state.name));
  const statesByName = new Map(initialStates.map((state) => [state.name, state] as const));
  const readyNames = new Set(
    initialStates.filter((state) => state.status === "Healthy").map((state) => state.name),
  );
  const prog = yield* output.progress({ max: initialStates.length });
  yield* prog.start("Waiting for services...");

  const fiber = yield* Stream.runForEach(stack.allStateChanges(), (state) =>
    Effect.sync(() => {
      const previousState = statesByName.get(state.name);
      statesByName.set(state.name, state);
      if (!stateNames.has(state.name) || previousState?.status === state.status) {
        return [];
      }
      return [state];
    }).pipe(
      Effect.flatMap((changedStates) =>
        Effect.forEach(
          changedStates,
          (serviceState) => {
            if (serviceState.status === "Healthy") {
              if (readyNames.has(serviceState.name)) {
                return Effect.void;
              }

              readyNames.add(serviceState.name);
              return prog.advance(1, `${serviceState.name} is ready`);
            }

            return prog.message(`${serviceState.name}: ${serviceState.status}`);
          },
          { discard: true },
        ),
      ),
    ),
  ).pipe(
    Effect.catch(() => Effect.void),
    Effect.forkChild({ startImmediately: true }),
  );

  const debugLogFiber = debugEnabled
    ? yield* stack.subscribeAllLogs().pipe(
        Stream.filter((entry) => entry.service !== "edge-runtime"),
        Stream.runForEach((entry) =>
          output.event({
            type: "log-entry",
            timestamp: new Date(entry.timestamp).toISOString(),
            service: entry.service,
            stream: entry.stream,
            line: entry.line,
            source: "live",
          }),
        ),
        Effect.catch(() => Effect.void),
        Effect.forkChild({ startImmediately: true }),
      )
    : undefined;

  yield* stack.start().pipe(
    Effect.tapError(() => emitStartupDiagnostics("startup failed")),
    Effect.ensuring(
      Effect.gen(function* () {
        yield* Fiber.interrupt(fiber);
        if (debugLogFiber !== undefined) {
          yield* Fiber.interrupt(debugLogFiber);
        }
      }),
    ),
  );
  yield* prog.stop("All services started");
});

export const printStackConnectionInfo = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const stack = yield* Stack;
  const info = yield* stack.getInfo();
  const serviceEndpoints = Object.entries(info.serviceEndpoints).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  yield* output.success("Local Supabase started", {
    api_url: info.url,
    db_url: info.dbUrl,
    publishable_key: info.publishableKey,
    secret_key: info.secretKey,
    services: Object.fromEntries(serviceEndpoints),
  });

  yield* output.info(`API URL: ${info.url}`);
  yield* output.info(`DB URL: ${info.dbUrl}`);
  yield* output.info(`Publishable key: ${info.publishableKey}`);
  yield* output.info(`Secret key: ${info.secretKey}`);

  for (const [name, endpoint] of serviceEndpoints) {
    yield* output.info(`${name}: ${endpoint}`);
  }
});
