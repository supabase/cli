import { Data, Effect, FileSystem, Option, Path, Redacted } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import type { EffectStack } from "@supabase/stack/effect";
import type { StackRuntime } from "@supabase/stack/effect";
import { parseConnectionString } from "./db-config.parse.ts";
import type { PgConnInput } from "./db-connection.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import { LocalDbRunningError } from "./db-bootstrap/local-db-running.ts";
import { currentStackBackend } from "./stack-backend.ts";
import { StackApi } from "./stack-api.ts";
import { loadStackConfig } from "../commands/experimental/stack/stack-config.ts";
import { postgresOnlyStackStartConfig } from "../commands/experimental/stack/start/start.options.ts";

const notRunning = (message = "supabase start is not running.") =>
  new LocalDbRunningError({ message });

const startFailed = (cause: { readonly message: string }) =>
  new LocalDbRunningError({
    message: `failed to start local database: ${cause.message}`,
  });

const databaseReady = (stack: EffectStack) =>
  Effect.gen(function* () {
    const status = yield* stack.status.pipe(Effect.mapError((cause) => notRunning(cause.message)));
    const database = status.capabilities.find((capability) => capability.name === "database");
    if (status.lifecycle !== "running" || database?.state !== "ready") return Option.none();
    return Option.some({ stack, runtime: status.runtime });
  });

const openProjectStack = () =>
  Effect.gen(function* () {
    const api = yield* Effect.serviceOption(StackApi);
    if (Option.isNone(api)) return Option.none();
    const cliSettings = yield* CommandSettings;
    const descriptor = yield* api.value
      .findStack({ projectRoot: cliSettings.workdir })
      .pipe(Effect.mapError((cause) => notRunning(cause.message)));
    if (Option.isNone(descriptor)) return Option.none();
    const stack = yield* api.value
      .openStack(descriptor.value.id)
      .pipe(Effect.mapError((cause) => notRunning(cause.message)));
    return yield* databaseReady(stack);
  });

/** Ready project stack, or none when the stack is missing or the database is not ready. */
export const stackOpenReadyProject = openProjectStack;

export const stackProjectRuntime: Effect.Effect<StackRuntime | undefined, never, CommandSettings> =
  Effect.gen(function* () {
    const api = yield* Effect.serviceOption(StackApi);
    if (Option.isNone(api)) return undefined;
    const cliSettings = yield* CommandSettings;
    const descriptor = yield* api.value
      .findStack({ projectRoot: cliSettings.workdir })
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return Option.match(descriptor, {
      onNone: () => undefined,
      onSome: (value) => value.runtime,
    });
  });

export class StackRuntimeUnavailableError extends Data.TaggedError("StackRuntimeUnavailableError")<{
  readonly message: string;
  readonly suggestion?: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

const RUNTIME_UNAVAILABLE = new StackRuntimeUnavailableError({
  message: "Could not determine the stack runtime.",
  suggestion: "Start the stack, or start with --runtime docker.",
});

/** Fail instead of treating an unknown engine as Docker. */
export const stackRequireProjectRuntime: Effect.Effect<
  StackRuntime,
  StackRuntimeUnavailableError,
  CommandSettings
> = Effect.gen(function* () {
  const api = yield* Effect.serviceOption(StackApi);
  if (Option.isNone(api)) return yield* RUNTIME_UNAVAILABLE;
  const cliSettings = yield* CommandSettings;
  const descriptor = yield* api.value.findStack({ projectRoot: cliSettings.workdir }).pipe(
    Effect.mapError(
      (cause) =>
        new StackRuntimeUnavailableError({
          message: cause.message,
          suggestion: RUNTIME_UNAVAILABLE.suggestion,
        }),
    ),
  );
  if (Option.isNone(descriptor)) return yield* RUNTIME_UNAVAILABLE;
  return descriptor.value.runtime;
});

const STACK_NATIVE_ENGINE_MESSAGE =
  "The stack backend only supports the pg-delta engine. Do not pass --use-migra, --use-pgadmin, --use-pg-schema, or --diff-engine migra.";

export class StackNativeEngineError extends Data.TaggedError("StackNativeEngineError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

export const stackRejectNativeDockerDiffEngine: Effect.Effect<void, StackNativeEngineError> =
  Effect.gen(function* () {
    const backend = yield* currentStackBackend;
    if (backend.kind !== "stack") return;
    return yield* new StackNativeEngineError({ message: STACK_NATIVE_ENGINE_MESSAGE });
  });

export const stackLocalDatabaseUrl: Effect.Effect<string, LocalDbRunningError, CommandSettings> =
  Effect.gen(function* () {
    const opened = yield* openProjectStack();
    if (Option.isNone(opened)) return yield* notRunning();
    const credentials = yield* opened.value.stack.credentials.pipe(
      Effect.mapError((cause) => notRunning(cause.message)),
    );
    return Redacted.value(credentials.database.url);
  });

export const stackLocalDatabaseConn: Effect.Effect<
  PgConnInput,
  LocalDbRunningError,
  CommandSettings
> = Effect.gen(function* () {
  const url = yield* stackLocalDatabaseUrl;
  const conn = parseConnectionString(url);
  if (conn === undefined) {
    return yield* notRunning(`failed to parse stack database URL`);
  }
  return conn;
});

/**
 * Start a postgres-only stack for `db start` and declarative local ensure. Fresh stacks persist
 * the overlay; an existing full project stack is started without rewriting `--exclude`.
 */
export const stackEnsurePostgresOnlyStarted: Effect.Effect<
  "already-running" | "started",
  LocalDbRunningError,
  CommandSettings | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const api = yield* Effect.serviceOption(StackApi);
  if (Option.isNone(api)) return yield* startFailed({ message: "stack API is unavailable" });
  const cliSettings = yield* CommandSettings;
  const existing = yield* api.value
    .findStack({ projectRoot: cliSettings.workdir })
    .pipe(Effect.mapError(startFailed));
  if (Option.isNone(existing) || existing.value.desiredLifecycle === "unconfigured") {
    const config = yield* loadStackConfig(cliSettings.workdir).pipe(Effect.mapError(startFailed));
    const stack = Option.isNone(existing)
      ? yield* api.value
          .createStack({ projectRoot: cliSettings.workdir })
          .pipe(Effect.mapError(startFailed))
      : yield* api.value.openStack(existing.value.id).pipe(Effect.mapError(startFailed));
    yield* stack
      .start({ config: postgresOnlyStackStartConfig(config) })
      .pipe(Effect.mapError(startFailed));
    return "started";
  }
  const stack = yield* api.value.openStack(existing.value.id).pipe(Effect.mapError(startFailed));
  const status = yield* stack.status.pipe(Effect.mapError(startFailed));
  const database = status.capabilities.find((capability) => capability.name === "database");
  if (status.lifecycle === "running" && database?.state === "ready") return "already-running";
  yield* stack.start().pipe(Effect.mapError(startFailed));
  return "started";
});
