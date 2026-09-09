import { NodeServices } from "@effect/platform-node";
import {
  Crypto,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  createStack as createEffectStack,
  discoverStacks as discoverEffectStacks,
  findStack as findEffectStack,
  inspectStack as inspectEffectStack,
  listStacks as listEffectStacks,
  openStack as openEffectStack,
  type EffectStack,
  type CreateStackOptions,
  type FindStackOptions,
  type ListStacksOptions,
  type StackDiscoveryResult,
  type StackDiscoveryIssue,
  type PrepareStackOptions,
  type StartStackOptions,
} from "./EffectStack.ts";
import type { StackConfig } from "./Config.ts";
import { StackConfigSchema } from "./Config.ts";
import { PromiseStackCredentialsSchema, type PromiseStackCredentials } from "./Credentials.ts";
import type { LogQuery, StackLogBatch, StackLogEntry } from "./Logs.ts";
import type { StackDescriptor, StackInspection, StackStatus } from "./Status.ts";
import type { StackId } from "./StackId.ts";
import type { PreparedCapability, PrepareStackResult } from "./EffectStack.ts";
import { InvalidStackConfigError } from "./Errors.ts";
import { StackRuntimeEnvironment, type StackRuntimeEnvironmentValue } from "../state/Ownership.ts";
import {
  createEphemeralPostgres as createEffectEphemeralPostgres,
  type CreateEphemeralPostgresOptions,
} from "./EphemeralPostgres.ts";
import type { StackRuntime } from "./Runtime.ts";

// oxlint-disable effecttsgo/async-function -- Promise facade methods must expose Promise/AsyncIterable APIs.
// oxlint-disable effecttsgo/any-unknown-in-error-context -- Promise callers receive native rejection values.

/** Recursively replaces Effect `Redacted` leaves with their plain value. */
type Unredacted<T> =
  T extends Redacted.Redacted<infer Value>
    ? Unredacted<Value>
    : T extends readonly (infer Item)[]
      ? ReadonlyArray<Unredacted<Item>>
      : T extends object
        ? { readonly [Key in keyof T]: Unredacted<T[Key]> }
        : T;

export type PromiseStackConfig = Unredacted<StackConfig>;
export type PromiseStartStackOptions = Omit<StartStackOptions, "config"> & {
  readonly config?: PromiseStackConfig;
};
export type PromisePrepareStackOptions = Omit<PrepareStackOptions, "config"> & {
  readonly config?: PromiseStackConfig;
};

export interface PromiseStack {
  readonly id: StackId;
  readonly status: () => Promise<StackStatus>;
  readonly credentials: () => Promise<PromiseStackCredentials>;
  readonly prepare: (options?: PromisePrepareStackOptions) => Promise<PrepareStackResult>;
  readonly start: (options?: PromiseStartStackOptions) => Promise<StackStatus>;
  readonly stop: () => Promise<void>;
  readonly destroy: () => Promise<void>;
  readonly logs: (query?: LogQuery) => Promise<StackLogBatch>;
  readonly followLogs: (query?: LogQuery) => AsyncIterable<StackLogEntry>;
}

export type PromiseCreateEphemeralPostgresOptions = Omit<
  CreateEphemeralPostgresOptions,
  "databasePassword" | "jwtSecret"
> & {
  readonly databasePassword: string;
  readonly jwtSecret: string;
};

export interface PromiseEphemeralPostgres {
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly runtime: StackRuntime;
  readonly artifactIdentity: string;
  readonly url: string;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly exportPgData: (tarPath: string) => Promise<void>;
  readonly destroy: () => Promise<void>;
}

interface PromiseStackApi {
  readonly createStack: (options: CreateStackOptions) => Promise<PromiseStack>;
  readonly openStack: (id: StackId) => Promise<PromiseStack>;
  readonly findStack: (options: FindStackOptions) => Promise<StackDescriptor | undefined>;
  readonly listStacks: (options?: ListStacksOptions) => Promise<ReadonlyArray<StackDescriptor>>;
  readonly discoverStacks: (options?: ListStacksOptions) => Promise<StackDiscoveryResult>;
  readonly inspectStack: (id: StackId) => Promise<StackInspection>;
  readonly createEphemeralPostgres: (
    options: PromiseCreateEphemeralPostgresOptions,
  ) => Promise<PromiseEphemeralPostgres>;
}

type PlatformLayer = typeof NodeServices.layer;
type RuntimeRequirements =
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner;

// Turns plain JSON config values into the Redacted values the Effect handle expects.
const stackConfigJsonCodec = Schema.toCodecJson(StackConfigSchema);
const decodePromiseConfig = (
  input: PromiseStackConfig,
): Effect.Effect<StackConfig, InvalidStackConfigError> =>
  Schema.decodeEffect(stackConfigJsonCodec)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (cause) =>
        new InvalidStackConfigError({
          message: `Invalid stack config: ${String(cause)}`,
          cause,
        }),
    ),
  );

/** Recursively unwraps every Redacted value at the Promise boundary. */
function unredact<T>(input: T): Unredacted<T>;
function unredact(input: unknown): unknown {
  if (Redacted.isRedacted(input)) return unredact(Redacted.value(input));
  if (Array.isArray(input)) return input.map(unredact);
  if (typeof input === "object" && input !== null) {
    const output: Record<PropertyKey, unknown> = {};
    for (const [key, value] of Object.entries(input)) output[key] = unredact(value);
    return output;
  }
  return input;
}

const adaptStream = <A, E>(stream: Stream.Stream<A, E>): AsyncIterable<A> =>
  Stream.toAsyncIterable(stream);

/** Adapts an already-created Effect handle; exported for facade integration tests. */
export const adaptEffectStack = (effectStack: EffectStack): PromiseStack => {
  const invoke = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect);
  const withConfig = <A>(
    options: { readonly config?: PromiseStackConfig } | undefined,
    operation: (config?: StackConfig) => Effect.Effect<A, unknown>,
  ): Effect.Effect<A, unknown> =>
    Effect.gen(function* () {
      const config =
        options?.config === undefined ? undefined : yield* decodePromiseConfig(options.config);
      return yield* operation(config);
    });
  return {
    id: effectStack.id,
    status: () => invoke(effectStack.status()),
    credentials: () =>
      invoke(effectStack.credentials()).then((value) =>
        Schema.decodeSync(PromiseStackCredentialsSchema)(unredact(value)),
      ),
    prepare: (options) =>
      invoke(
        withConfig(options, (config) =>
          effectStack.prepare(
            options === undefined
              ? undefined
              : {
                  ...(options.capabilities === undefined
                    ? {}
                    : { capabilities: options.capabilities }),
                  ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
                  ...(config === undefined ? {} : { config }),
                },
          ),
        ),
      ),
    start: (options) =>
      invoke(
        withConfig(options, (config) =>
          options === undefined
            ? effectStack.start()
            : effectStack.start(config === undefined ? {} : { config }),
        ),
      ),
    stop: () => invoke(effectStack.stop()),
    destroy: () => invoke(effectStack.destroy()),
    logs: (query) => invoke(effectStack.logs(query)),
    followLogs: (query) => adaptStream(effectStack.followLogs(query)),
  };
};

export const makePromiseApi = (
  platformLayer: PlatformLayer = NodeServices.layer,
  runtimeEnvironment?: StackRuntimeEnvironmentValue,
): PromiseStackApi => {
  const providedLayer =
    runtimeEnvironment === undefined
      ? platformLayer
      : Layer.mergeAll(platformLayer, Layer.succeed(StackRuntimeEnvironment, runtimeEnvironment));
  const run = async <A, E>(effect: Effect.Effect<A, E, RuntimeRequirements>): Promise<A> => {
    return await Effect.runPromise(effect.pipe(Effect.provide(providedLayer)));
  };

  const createOrOpen = async (
    effect: Effect.Effect<EffectStack, unknown, RuntimeRequirements>,
  ): Promise<PromiseStack> => adaptEffectStack(await run(effect));
  return {
    createStack: (options) => createOrOpen(createEffectStack(options)),
    openStack: (id) => createOrOpen(openEffectStack(id)),
    findStack: (options) =>
      run(findEffectStack(options)).then((value) => Option.getOrUndefined(value)),
    listStacks: (options) => run(listEffectStacks(options)),
    discoverStacks: (options) => run(discoverEffectStacks(options)),
    inspectStack: (id) => run(inspectEffectStack(id)),
    createEphemeralPostgres: async (options) => {
      const scope = await Effect.runPromise(Scope.make());
      const close = () =>
        Effect.runPromise(Scope.close(scope, Exit.void).pipe(Effect.provide(providedLayer)));
      const invoke = <A>(
        effect: Effect.Effect<A, unknown, RuntimeRequirements | Scope.Scope>,
      ): Promise<A> =>
        Effect.runPromise(
          effect.pipe(Effect.provideService(Scope.Scope, scope), Effect.provide(providedLayer)),
        );
      try {
        const handle = await invoke(
          createEffectEphemeralPostgres({
            ...options,
            databasePassword: Redacted.make(options.databasePassword),
            jwtSecret: Redacted.make(options.jwtSecret),
          }),
        );
        return {
          host: handle.host,
          port: handle.port,
          version: handle.version,
          runtime: handle.runtime,
          artifactIdentity: handle.artifactIdentity,
          url: Redacted.value(handle.url),
          start: () => invoke(handle.start()),
          stop: () => invoke(handle.stop()),
          exportPgData: (tarPath) => invoke(handle.exportPgData(tarPath)),
          destroy: close,
        };
      } catch (cause) {
        await close().catch(() => undefined);
        throw cause;
      }
    },
  };
};

const defaultApi = makePromiseApi();
export const createStack = defaultApi.createStack;
export const openStack = defaultApi.openStack;
export const findStack = defaultApi.findStack;
export const listStacks = defaultApi.listStacks;
export const discoverStacks = defaultApi.discoverStacks;
export const inspectStack = defaultApi.inspectStack;
export const createEphemeralPostgres = defaultApi.createEphemeralPostgres;

export type {
  CreateStackOptions,
  FindStackOptions,
  ListStacksOptions,
  PreparedCapability,
  StackDiscoveryIssue,
  StackDiscoveryResult,
};
