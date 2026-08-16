import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Data, Effect, Layer } from "effect";
import { FileSystem, Path } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ApiProxy, type ProxyConfig } from "./ApiProxy.ts";
import { BinaryResolver } from "./BinaryResolver.ts";
import type { PlatformFactory } from "./createStack.ts";
import { supervisorLayer, type SupervisorStartMessage } from "./supervisor.ts";
import type { ControlEndpoint } from "./managed/control.ts";
import type { PortLease } from "./PortAllocator.ts";
import { RemoteStack } from "./RemoteStack.ts";
import { Stack } from "./Stack.ts";
import { LocalStackLifecycle, localStackLayer } from "./LocalStack.ts";
import { StackMetadataPersistence } from "./StackMetadataPersistence.ts";
import { StackPreparation } from "./StackPreparation.ts";
import {
  InvalidStackStateError,
  NoRunningStackError,
  StateManager,
  singleStackStateManagerPaths,
} from "./StateManager.ts";
import { StackBuilder } from "./StackBuilder.ts";
import type { ResolvedDaemonConfig, ResolvedStackConfig } from "./StackConfig.ts";
import { sanitizeDaemonConfigInput, type DaemonConfigInput } from "./StackConfigResolver.ts";
import { UnixHttpClient } from "./UnixHttpClient.ts";
import { resolveManagedStack } from "./managed-stack.ts";
import { DEFAULT_MANAGED_STACK_NAME, defaultCacheRoot, defaultManagedStackRoot } from "./paths.ts";

/**
 * Inputs owned by the process that will boot the runtime. The lease is passed
 * through unchanged: runtime service activation releases fields from this
 * exact lease rather than probing or allocating a second port set.
 */
export interface RuntimeBootInput {
  readonly config: ResolvedStackConfig;
  readonly lease: PortLease;
}

export interface RuntimeBootOptions {
  readonly metadataPersistence?: Layer.Layer<
    StackMetadataPersistence,
    never,
    FileSystem.FileSystem | Path.Path
  >;
  readonly platform?: ReturnType<PlatformFactory>;
}

/**
 * Build a foreground layer that runs the stack in-process.
 *
 * Wires: BinaryResolver → StackBuilder → Stack + ApiProxy + platform.
 * Returns a fully self-contained layer with no remaining requirements.
 */
const runtimeBootLayer = (
  input: RuntimeBootInput,
  platformFactory: PlatformFactory,
  options: RuntimeBootOptions = {},
): Layer.Layer<Stack | ApiProxy | LocalStackLifecycle> => {
  const config = input.config;
  const portLease = input.lease;
  const platform =
    options.platform ??
    platformFactory({
      apiPort: config.apiPort,
      releaseApiPort: portLease.release(["apiPort"]),
    });

  const binaryResolverLayer = BinaryResolver.make(config.cacheRoot).pipe(
    Layer.provide(FetchHttpClient.layer),
  );
  const stackPreparationLayer = StackPreparation.layer.pipe(Layer.provide(binaryResolverLayer));
  const stackLayer = localStackLayer(config, portLease).pipe(
    Layer.provide(StackBuilder.layer),
    Layer.provide(stackPreparationLayer),
    Layer.provide(options.metadataPersistence ?? StackMetadataPersistence.noop),
  );

  const proxyConfig: ProxyConfig = {
    listenPort: config.apiPort,
    gotruePort: config.auth !== false ? config.auth.port : 0,
    postgrestPort: config.postgrest !== false ? config.postgrest.port : 0,
    postgrestAdminPort: config.postgrest !== false ? config.postgrest.adminPort : 0,
    edgeRuntimePort: config.edgeRuntime !== false ? config.edgeRuntime.port : 0,
    realtimePort: config.realtime !== false ? config.realtime.port : 0,
    storagePort: config.storage !== false ? config.storage.port : 0,
    pgmetaPort: config.pgmeta !== false ? config.pgmeta.port : 0,
    analyticsPort: config.analytics !== false ? config.analytics.port : 0,
    poolerPort: config.pooler !== false ? config.pooler.apiPort : 0,
    studioPort: config.studio !== false ? config.studio.port : 0,
    publishableKey: config.publishableKey,
    secretKey: config.secretKey,
    anonJwt: config.anonJwt,
    serviceRoleJwt: config.serviceRoleJwt,
  };
  const apiProxyLayer = ApiProxy.layer(proxyConfig).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(stackLayer),
  );

  return Layer.mergeAll(stackLayer, apiProxyLayer).pipe(Layer.provide(platform), Layer.orDie);
};

/** Build an in-process stack runtime with an already selected lease. */
export const foregroundLayer = (
  config: ResolvedStackConfig,
  platformFactory: PlatformFactory,
  portLease: PortLease,
): Layer.Layer<Stack | ApiProxy | LocalStackLifecycle> =>
  runtimeBootLayer({ config, lease: portLease }, platformFactory);

// ---------------------------------------------------------------------------
// Detached mode errors
// ---------------------------------------------------------------------------

export class DaemonStartError extends Data.TaggedError("DaemonStartError")<{
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// Daemon-backed mode
// ---------------------------------------------------------------------------

export const foregroundDaemonLayer = (
  config: ResolvedDaemonConfig,
  platformFactory: PlatformFactory,
  portLease: PortLease,
): Layer.Layer<Stack | StateManager | ApiProxy | LocalStackLifecycle> => {
  const stateManagerLayer = StateManager.make(
    singleStackStateManagerPaths(config.stackRoot, config.runtimeRoot, config.name),
  );
  const metadataPersistenceLayer = StackMetadataPersistence.fromStateManager(config.name).pipe(
    Layer.provide(stateManagerLayer),
  );
  const platform = platformFactory({
    apiPort: config.apiPort,
    releaseApiPort: portLease.release(["apiPort"]),
  });
  const runtimeLayer = runtimeBootLayer({ config, lease: portLease }, platformFactory, {
    metadataPersistence: metadataPersistenceLayer,
    platform,
  }).pipe(Layer.provide(stateManagerLayer));
  return Layer.mergeAll(runtimeLayer, stateManagerLayer).pipe(Layer.provide(platform), Layer.orDie);
};

/** Fork the unified supervisor and return a RemoteStack layer connected to it. */
export const daemonLayer = (
  input: DaemonConfigInput,
  daemonEntryPoint: string,
): Effect.Effect<
  Layer.Layer<Stack>,
  DaemonStartError | InvalidStackStateError,
  FileSystem.FileSystem | Path.Path | UnixHttpClient
> =>
  Effect.gen(function* () {
    const daemonInput = sanitizeDaemonConfigInput(input);
    if (daemonInput.stackRoot !== undefined || daemonInput.runtimeRoot !== undefined) {
      return yield* new DaemonStartError({
        message: "Managed daemon stacks derive stackRoot and runtimeRoot automatically",
      });
    }
    const projectDir = daemonInput.projectDir ?? daemonInput.cwd;
    const name = daemonInput.name ?? DEFAULT_MANAGED_STACK_NAME;
    const cacheRoot = daemonInput.cacheRoot ?? defaultCacheRoot();
    const stackRoot =
      daemonInput.projectStateRoot !== undefined
        ? join(daemonInput.projectStateRoot, "stacks", name)
        : defaultManagedStackRoot(cacheRoot, projectDir, name);
    const config: DaemonConfigInput = {
      ...daemonInput,
      cacheRoot,
      projectDir,
      name,
    };
    const unixHttpClient = yield* UnixHttpClient;
    const ownershipId = randomOwnershipId();
    const startMsg: SupervisorStartMessage = {
      type: "start",
      mode: "ephemeral",
      ownershipId,
      stackId: ownershipId,
      workspacePath: projectDir,
      stackName: name,
      stateRoot: stackRoot,
      config,
    };
    return yield* supervisorLayer(startMsg, daemonEntryPoint).pipe(
      Effect.provideService(UnixHttpClient, unixHttpClient),
      Effect.mapError((error) => new DaemonStartError({ message: error.message })),
    );
  });

const randomOwnershipId = (): string =>
  `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;

const stateSocket = (value: string): string | ControlEndpoint => {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return value;
    return {
      _tag: "Loopback",
      hostname: url.hostname,
      host: url.hostname,
      port: Number(url.port),
      url: value,
      path: value,
    };
  } catch {
    return value;
  }
};

// ---------------------------------------------------------------------------
// Connect mode
// ---------------------------------------------------------------------------

/**
 * Connect to an already-running daemon by resolving its state from the filesystem.
 *
 * Looks up the running stack for the given name or working directory,
 * verifies it's still alive, and returns a RemoteStack layer.
 */
export const connectLayer = (opts: {
  name?: string;
  cwd?: string;
  cacheRoot: string;
  projectDir?: string;
  projectStateRoot?: string;
}): Effect.Effect<
  Layer.Layer<Stack>,
  NoRunningStackError | InvalidStackStateError,
  FileSystem.FileSystem | Path.Path | UnixHttpClient
> =>
  Effect.gen(function* () {
    const cwd = opts.cwd ?? process.cwd();
    const unixHttpClient = yield* UnixHttpClient;
    const { state, alive } = yield* resolveManagedStack(opts);
    if (!alive) {
      return yield* new NoRunningStackError({ cwd });
    }

    return RemoteStack.layer(stateSocket(state.socketPath)).pipe(
      Layer.provide(Layer.succeed(UnixHttpClient, unixHttpClient)),
    );
  });
