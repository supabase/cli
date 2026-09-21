import type { ServiceCreation, Stack } from "@supabase/stack/effect";
import { DateTime, Effect, Equal, Fiber, Option, Path, Stream, type Scope } from "effect";
import { Output } from "../../../shared/output/output.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { ProcessControl } from "../../../shared/runtime/process-control.service.ts";
import { loadStackConfig, StackConfigError } from "../../../command-internal/stack-config.ts";
import {
  readStackFunctionsEnv,
  StackFunctionsEnvError,
} from "../../../command-internal/stack-functions-env.ts";
import { LocalDbRunningError } from "../../../command-internal/db-bootstrap/local-db-running.ts";
import { stackOpenReadyProject } from "../../../command-internal/stack-local-database.ts";
import { OutputFlag } from "../../../command-internal/global-flags.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { FunctionsServeFlags } from "../../../shared/functions/serve.ts";
import { FunctionsServeStackError } from "./serve.errors.ts";

type Instance = Effect.Success<ReturnType<Stack["services"]["get"]>>;
type FunctionsInstance = Extract<Instance, { readonly service: "functions" }>;
type FunctionsCreation = Extract<ServiceCreation, { readonly service: "functions" }>;

const runtimeError = (cause: { readonly message: string }) =>
  cause instanceof FunctionsServeStackError
    ? cause
    : new FunctionsServeStackError({
        reason:
          cause instanceof StackFunctionsEnvError || cause instanceof StackConfigError
            ? "invalid-config"
            : cause instanceof LocalDbRunningError
              ? "lifecycle"
              : "runtime",
        message: cause.message,
        cause,
      });
const invalidConfig = (message: string) =>
  new FunctionsServeStackError({ reason: "invalid-config", message });

const follow = Effect.fn("functions.serve.follow")(function* (
  instance: FunctionsInstance,
  launch: Effect.Effect<void, { readonly message: string }, Scope.Scope>,
) {
  const output = yield* Output;
  const logs = yield* instance.logs.pipe(
    Stream.groupByKey((entry) => entry.stream),
    Stream.flatMap(
      ([channel, entries]) =>
        entries.pipe(
          Stream.map(({ bytes }) => bytes),
          Stream.decodeText,
          Stream.splitLines,
          Stream.map((line) => ({ channel, line })),
        ),
      { concurrency: 2 },
    ),
    Stream.runForEach(
      Effect.fn(function* ({ channel, line }) {
        const timestamp = DateTime.formatIso(yield* DateTime.now);
        yield* output.format === "stream-json"
          ? output.event({
              type: "log-entry",
              timestamp,
              source: "live",
              service: "functions",
              instance_id: instance.id,
              stream: channel,
              line,
            })
          : output.raw(`${line}\n`, channel);
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* launch;
  yield* instance.ready;
  const url = (yield* instance.credentials()).url;
  if (url === undefined) return yield* invalidConfig("Functions has no public HTTP endpoint.");
  if (output.format === "stream-json") yield* output.result({ instance_id: instance.id, url });
  else yield* output.raw(`Serving Functions at ${url}\n`);
  yield* Effect.raceFirst(
    Fiber.join(logs).pipe(
      Effect.andThen(
        Effect.fail(
          new FunctionsServeStackError({
            reason: "runtime",
            message: "The Functions log stream ended.",
          }),
        ),
      ),
    ),
    instance.followStatus.pipe(
      Stream.runForEach((status) => {
        if (status.currentOperation === "restart") return Effect.void;
        return status.lifecycle === "stopped" ||
          status.health === "unhealthy" ||
          status.error !== undefined
          ? Effect.fail(
              new FunctionsServeStackError({
                reason: "runtime",
                message:
                  status.error?.message ?? "The Functions service stopped or became unhealthy.",
                suggestion: "Run supabase start to make Functions available again.",
              }),
            )
          : Effect.void;
      }),
    ),
  );
});

const session = Effect.fn("functions.serve.session")(function* (flags: FunctionsServeFlags) {
  const output = yield* Output;
  const processControl = yield* ProcessControl;
  const settings = yield* CommandSettings;
  const runtime = yield* RuntimeInfo;
  const path = yield* Path.Path;
  const legacyOutput = yield* OutputFlag;
  if (output.format === "json" || Option.isSome(legacyOutput))
    return yield* new FunctionsServeStackError({
      reason: "flags",
      message: "Functions serve requires text or stream-json output.",
      suggestion: "Use --output-format stream-json for structured live output.",
    });
  if (
    Option.isSome(flags.importMap) ||
    flags.inspect ||
    Option.isSome(flags.inspectMode) ||
    flags.inspectMain
  )
    return yield* new FunctionsServeStackError({
      reason: "flags",
      message: "Import-map and inspector flags are not supported by experimental Functions serve.",
      suggestion: "Remove --import-map, --inspect, --inspect-mode, and --inspect-main.",
    });
  const opened = yield* stackOpenReadyProject;
  if (Option.isNone(opened))
    return yield* new FunctionsServeStackError({
      reason: "lifecycle",
      message: "The local stack is not running.",
      suggestion: "Run supabase start first.",
    });
  const { stack, database } = opened.value;
  const composition = yield* stack.composition.describe;
  const instances = yield* stack.services.list;
  const members = instances.filter(({ id }) =>
    composition.members.some((member) => member.id === id),
  );
  const existing = members.find((instance) => instance.service === "functions");
  const envOverride = Option.isSome(flags.envFile)
    ? yield* readStackFunctionsEnv(path.resolve(runtime.cwd, flags.envFile.value), false)
    : undefined;
  const cleanupWarning = (message: string, error: { readonly message: string }) =>
    output
      .raw(`${message}: ${error.message}\n`, "stderr")
      .pipe(Effect.andThen(processControl.setExitCode(1)));

  if (existing?.service === "functions") {
    const before = yield* existing.status;
    if (before.config.service !== "functions")
      return yield* invalidConfig("Invalid saved Functions configuration.");
    const saved = before.config.config;
    const desired = {
      ...saved,
      ...(envOverride === undefined ? {} : { env: { ...saved.env, ...envOverride } }),
      ...(Option.isSome(flags.noVerifyJwt) ? { verifyJwt: !flags.noVerifyJwt.value } : {}),
    };
    const changed = !Equal.equals(saved, desired);
    const launch = changed
      ? Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const mutation = yield* restore(existing.restart({ config: desired })).pipe(
              Effect.forkScoped(),
            );
            // A submitted restart must settle before cleanup reads its persisted configuration.
            yield* Effect.addFinalizer(() =>
              Fiber.await(mutation).pipe(
                Effect.andThen(existing.status),
                Effect.flatMap((current) =>
                  Equal.equals(current.config.config, desired) ||
                  (Equal.equals(current.config.config, saved) && current.lifecycle === "stopped")
                    ? existing.restart({ config: saved })
                    : Effect.void,
                ),
                Effect.catch((error) =>
                  cleanupWarning("Failed to restore Functions configuration", error),
                ),
              ),
            );
            return yield* restore(Fiber.join(mutation));
          }),
        )
      : existing.start;
    yield* follow(existing, launch);
    return;
  }

  for (const instance of instances) {
    if (instance.service !== "functions") continue;
    const status = yield* instance.status;
    if (status.lifecycle !== "stopped" || status.wakeEnabled)
      return yield* new FunctionsServeStackError({
        reason: "lifecycle",
        message: `Standalone Functions instance ${instance.id} is already active.`,
        suggestion: "Stop the stack before starting another Functions serving session.",
      });
  }
  const databaseStatus = yield* database.status;
  if (databaseStatus.config.service !== "database")
    return yield* invalidConfig("Invalid saved database configuration.");
  const config = yield* loadStackConfig(settings.workdir);
  const creations = yield* config.creations(stack.id, {
    jwtSecret: databaseStatus.config.config.jwtSecret,
  });
  const source = creations.find(
    (creation): creation is FunctionsCreation => creation.service === "functions",
  );
  if (source === undefined)
    return yield* invalidConfig(
      "Enable edge_runtime in supabase/config.toml before serving Functions.",
    );
  const databaseUrl = (yield* database.credentials({ from: "runtime" })).databaseUrl;
  if (databaseUrl === undefined) return yield* invalidConfig("The database has no runtime URL.");
  const apiSource = [...members, ...instances].find(
    (instance) =>
      instance.service === "rest" || instance.service === "auth" || instance.service === "storage",
  );
  const apiStatus = apiSource === undefined ? undefined : yield* apiSource.status;
  const savedPort = apiStatus?.endpoints.find(({ name }) => name === "http")?.port;
  const requestedPort = source.endpoints?.http?.port;
  const port =
    savedPort ?? (typeof requestedPort === "number" ? requestedPort : config.source.api.port);
  const databaseAddress = URL.parse(databaseUrl);
  if (databaseAddress === null) return yield* invalidConfig("Invalid runtime database URL.");
  const apiUrl =
    apiSource === undefined
      ? `http://${databaseAddress.hostname}:${port}`
      : (yield* apiSource.credentials({ from: "runtime" })).apiUrl;
  if (apiUrl === undefined) return yield* invalidConfig("The stack has no runtime API URL.");
  const env =
    envOverride ?? (yield* readStackFunctionsEnv(`${source.config.functionsRoot}/.env`, true));
  const creation: FunctionsCreation = {
    ...source,
    config: {
      ...source.config,
      apiUrl,
      databaseUrl,
      env: { ...env, ...source.config.env, ...envOverride },
      ...(Option.isSome(flags.noVerifyJwt) ? { verifyJwt: !flags.noVerifyJwt.value } : {}),
    },
    endpoints: { ...source.endpoints, http: { port } },
  };
  const temporary = yield* Effect.acquireRelease(stack.services.create(creation), (instance) =>
    instance.status.pipe(
      Effect.andThen(instance.destroy),
      Effect.catch((error) => cleanupWarning("Failed to remove temporary Functions", error)),
    ),
  );
  yield* follow(temporary, temporary.start);
});

export const functionsServeStack = Effect.fn("functions.serve.stack")(function* (
  flags: FunctionsServeFlags,
) {
  const telemetry = yield* TelemetryState;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const control = yield* ProcessControl;
      yield* control.holdSignals(["SIGINT", "SIGTERM"]);
      const shutdown = yield* control
        .awaitSignal()
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.raceFirst(Fiber.join(shutdown).pipe(Effect.asVoid), session(flags));
    }),
  ).pipe(Effect.mapError(runtimeError), Effect.ensuring(telemetry.flush));
});
