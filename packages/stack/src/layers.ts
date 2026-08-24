import { join } from "node:path";
import { Data, Effect, Layer } from "effect";
import { FileSystem, Path } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { ApiProxy, type ProxyConfig } from "./ApiProxy.ts";
import { BinaryResolver } from "./BinaryResolver.ts";
import type { PlatformFactory } from "./createStack.ts";
import { supervisorLayer, type SupervisorStartMessage } from "./supervisor.ts";
import type { PortLease } from "./PortAllocator.ts";
import { Stack } from "./Stack.ts";
import { LocalStackLifecycle, localStackLayer } from "./LocalStack.ts";
import { StackPreparation } from "./StackPreparation.ts";
import { StackBuilder } from "./StackBuilder.ts";
import type { ResolvedStackConfig } from "./StackConfig.ts";
import { sanitizeDaemonConfigInput, type DaemonConfigInput } from "./StackConfigResolver.ts";
import { HttpTransportClient } from "./HttpTransportClient.ts";
import { DEFAULT_MANAGED_STACK_NAME, defaultCacheRoot } from "./paths.ts";
import type { ManagedStackLaunchInput } from "./managed/document.ts";
import type { ManagedPortIntentDocument } from "./managed/model.ts";
import { deriveStackId, ensureEnvironment } from "./managed/environment.ts";
import { gitConfigStoreLayer } from "./managed/git.ts";
import {
  DaemonUpgradeRequired,
  StackRpcProtocolError,
  StackRpcTransportError,
  StopTimeout,
  UpgradePreflightError,
  UpgradeRestartError,
} from "./errors.ts";

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

/** Managed-only additions kept outside the generic daemon config resolver. */
export type ManagedDaemonConfigInput = DaemonConfigInput & {
  readonly cliVersion: string;
  readonly portIntents: ManagedPortIntentDocument;
  readonly launch?: ManagedStackLaunchInput;
};

// ---------------------------------------------------------------------------
// Daemon-backed mode
// ---------------------------------------------------------------------------

const managedSupervisorLayer = (
  input: ManagedDaemonConfigInput,
  daemonEntryPoint: string,
  type: SupervisorStartMessage["type"],
): Effect.Effect<
  Layer.Layer<Stack, DaemonUpgradeRequired | StackRpcProtocolError | StackRpcTransportError>,
  | DaemonStartError
  | DaemonUpgradeRequired
  | UpgradePreflightError
  | UpgradeRestartError
  | StopTimeout,
  FileSystem.FileSystem | Path.Path | HttpTransportClient
> =>
  Effect.gen(function* () {
    // Keep managed coordination metadata out of the generic daemon config.
    const { portIntents, launch, ...daemonConfigInput } = input;
    const daemonInput = sanitizeDaemonConfigInput(daemonConfigInput);
    if (daemonInput.stackRoot !== undefined || daemonInput.runtimeRoot !== undefined) {
      return yield* new DaemonStartError({
        message: "Managed daemon stacks derive stackRoot and runtimeRoot automatically",
      });
    }
    const projectDir = daemonInput.projectDir ?? daemonInput.cwd;
    const name = daemonInput.name ?? DEFAULT_MANAGED_STACK_NAME;
    const cacheRoot = daemonInput.cacheRoot ?? defaultCacheRoot();
    const stateRoot = join(cacheRoot, "managed");
    const config: DaemonConfigInput = {
      ...daemonInput,
      cacheRoot,
      projectDir,
      name,
    };
    const httpTransportClient = yield* HttpTransportClient;
    const discovery = yield* ensureEnvironment(projectDir).pipe(
      Effect.provide(gitConfigStoreLayer),
      Effect.mapError((error) =>
        error instanceof DaemonUpgradeRequired
          ? error
          : new DaemonStartError({ message: error.message }),
      ),
    );
    const startMsg: SupervisorStartMessage = {
      type,
      cliVersion: input.cliVersion,
      stackId: deriveStackId(discovery.identity, name),
      workspacePath: projectDir,
      stackName: name,
      stateRoot,
      config,
      portIntents,
      ...(launch === undefined ? {} : { launch }),
    };
    return yield* supervisorLayer(startMsg, daemonEntryPoint).pipe(
      Effect.provideService(HttpTransportClient, httpTransportClient),
      Effect.mapError((error) =>
        error instanceof DaemonUpgradeRequired ||
        error instanceof UpgradePreflightError ||
        error instanceof UpgradeRestartError ||
        error instanceof StopTimeout
          ? error
          : new DaemonStartError({ message: error.message }),
      ),
    );
  });

/** Fork the unified supervisor and return a RemoteStack layer connected to it. */
export const daemonLayer = (input: ManagedDaemonConfigInput, daemonEntryPoint: string) =>
  managedSupervisorLayer(input, daemonEntryPoint, "start");

/** Explicitly authorize a full stop/start when the current owner is incompatible. */
export const restartManagedStackForUpgrade = (
  input: ManagedDaemonConfigInput,
  daemonEntryPoint: string,
): Effect.Effect<
  Layer.Layer<Stack, DaemonUpgradeRequired | StackRpcProtocolError | StackRpcTransportError>,
  | DaemonStartError
  | DaemonUpgradeRequired
  | UpgradePreflightError
  | UpgradeRestartError
  | StopTimeout,
  FileSystem.FileSystem | Path.Path | HttpTransportClient
> => managedSupervisorLayer(input, daemonEntryPoint, "upgrade-restart");
