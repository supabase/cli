import { Data, Effect, FileSystem, Option, Path, Redacted } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import type { ChildProcessSpawner as ChildProcessSpawnerType } from "effect/unstable/process/ChildProcessSpawner";
import type { EffectStack } from "@supabase/stack/effect";
import type { StackRuntime } from "@supabase/stack/effect";
import { parseConnectionString } from "./db-config.parse.ts";
import type { PgConnInput } from "./db-connection.service.ts";
import { CommandSettings } from "../config/command-settings.service.ts";
import {
  LocalDbRunningError,
  isLocalDbRunning,
  type LocalDockerEngine,
} from "./db-bootstrap/local-db-running.ts";
import { currentStackBackend } from "../commands/experimental/stack/stack-backend.ts";
import { StackApi } from "../commands/experimental/stack/stack.shared.ts";
import { loadStackConfig } from "../commands/experimental/stack/stack-config.ts";

const notRunning = (message = "supabase start is not running.") =>
  new LocalDbRunningError({ message });

const databaseReady = (stack: EffectStack) =>
  Effect.gen(function* () {
    const status = yield* stack
      .status()
      .pipe(Effect.mapError((cause) => notRunning(cause.message)));
    const database = status.capabilities.find((capability) => capability.name === "database");
    if (status.lifecycle !== "running" || database?.state !== "ready") return Option.none();
    return Option.some({ stack, runtime: status.runtime });
  });

const openProjectStack = () =>
  Effect.gen(function* () {
    const api = yield* StackApi;
    const cliSettings = yield* CommandSettings;
    const descriptor = yield* api
      .findStack({ projectRoot: cliSettings.workdir })
      .pipe(Effect.mapError((cause) => notRunning(cause.message)));
    if (Option.isNone(descriptor)) return Option.none();
    const stack = yield* api
      .openStack(descriptor.value.id)
      .pipe(Effect.mapError((cause) => notRunning(cause.message)));
    return yield* databaseReady(stack);
  });

export const stackProjectRuntime: Effect.Effect<
  StackRuntime | undefined,
  never,
  CommandSettings
> = Effect.gen(function* () {
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

export const stackLocalDatabaseUrl: Effect.Effect<
  string,
  LocalDbRunningError,
  CommandSettings | StackApi
> = Effect.gen(function* () {
  const opened = yield* openProjectStack();
  if (Option.isNone(opened)) return yield* notRunning();
  const credentials = yield* opened.value.stack
    .credentials()
    .pipe(Effect.mapError((cause) => notRunning(cause.message)));
  return Redacted.value(credentials.database.url);
});

export const stackLocalDatabaseConn: Effect.Effect<
  PgConnInput,
  LocalDbRunningError,
  CommandSettings | StackApi
> = Effect.gen(function* () {
  const url = yield* stackLocalDatabaseUrl;
  const conn = parseConnectionString(url);
  if (conn === undefined) {
    return yield* notRunning(`failed to parse stack database URL`);
  }
  return conn;
});

const stackLocalDatabaseIsRunning: Effect.Effect<
  boolean,
  LocalDbRunningError,
  CommandSettings | StackApi
> = openProjectStack().pipe(Effect.map(Option.isSome));

export const resolveLocalDatabaseIsRunning = (
  spawner: ChildProcessSpawnerType["Service"],
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  configuredProjectId: string | undefined,
): Effect.Effect<boolean, LocalDbRunningError, CommandSettings | LocalDockerEngine> =>
  Effect.gen(function* () {
    const backend = yield* currentStackBackend;
    if (backend.kind === "legacy")
      return yield* isLocalDbRunning(spawner, fs, path, workdir, configuredProjectId);
    const api = yield* Effect.serviceOption(StackApi);
    if (Option.isNone(api)) return false;
    return yield* stackLocalDatabaseIsRunning.pipe(Effect.provideService(StackApi, api.value));
  });

export const stackEnsureLocalDatabaseStarted: Effect.Effect<
  void,
  LocalDbRunningError,
  CommandSettings | FileSystem.FileSystem | Path.Path | StackApi
> = Effect.gen(function* () {
  const api = yield* StackApi;
  const cliSettings = yield* CommandSettings;
  const existing = yield* api.findStack({ projectRoot: cliSettings.workdir }).pipe(
    Effect.mapError(
      (cause) =>
        new LocalDbRunningError({
          message: `failed to start local database: ${cause.message}`,
        }),
    ),
  );
  const config = yield* loadStackConfig(cliSettings.workdir).pipe(
    Effect.mapError(
      (cause) =>
        new LocalDbRunningError({
          message: `failed to start local database: ${cause.message}`,
        }),
    ),
  );
  const stack = Option.isSome(existing)
    ? yield* api.openStack(existing.value.id).pipe(
        Effect.mapError(
          (cause) =>
            new LocalDbRunningError({
              message: `failed to start local database: ${cause.message}`,
            }),
        ),
      )
    : yield* api.createStack({ projectRoot: cliSettings.workdir }).pipe(
        Effect.mapError(
          (cause) =>
            new LocalDbRunningError({
              message: `failed to start local database: ${cause.message}`,
            }),
        ),
      );
  const status = yield* stack.status().pipe(
    Effect.mapError(
      (cause) =>
        new LocalDbRunningError({
          message: `failed to start local database: ${cause.message}`,
        }),
    ),
  );
  const database = status.capabilities.find((capability) => capability.name === "database");
  if (status.lifecycle === "running" && database?.state === "ready") return;
  yield* stack.start({ config }).pipe(
    Effect.mapError(
      (cause) =>
        new LocalDbRunningError({
          message: `failed to start local database: ${cause.message}`,
        }),
    ),
  );
});
