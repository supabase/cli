import { Duration, Effect, FileSystem, Path, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { validateStackRuntime, type StackRuntimeSelection } from "./ContainerRuntime.ts";
import type { SupervisorReplacingMessage, SupervisorStartMessage } from "./SupervisorProtocol.ts";
import {
  makeControlClient,
  type ControlAcquisition,
  type ControlAddressConflictError,
  type ControlBindError,
  type ControlAttached,
  type ControlProtocolError,
  type ControlProtocolMismatchError,
  type ControlTransportError,
  type ControlTransportShape,
  type InvalidControlOwnershipIdError,
} from "./managed/control.ts";
import type { ManagedStackManagerShape } from "./managed/manager.ts";
import { managedStackPathsEffect } from "./managed/paths.ts";
import type { ManagedStackLaunch } from "./managed/document.ts";
import { PORT_CATALOG, type PortField } from "./PortCatalog.ts";
import { portFieldsForConfigInput } from "./ServicePorts.ts";
import { SERVICE_CATALOG, SERVICE_NAMES } from "./ServiceCatalog.ts";
import type { ServiceName } from "./ServiceName.ts";
import {
  portRequestsForConfig,
  resolveConfig,
  type DaemonConfigInput,
} from "./StackConfigResolver.ts";
import {
  DaemonUpgradeRequired,
  StopTimeout,
  SupervisorStartError,
  UpgradePreflightError,
} from "./errors.ts";

export interface SupervisorReplacementContext {
  readonly stackId: string;
  readonly oldOwner: ControlAttached;
  readonly input: SupervisorStartMessage;
  readonly configInput: DaemonConfigInput;
  readonly manager: ManagedStackManagerShape;
  readonly controlTransport: ControlTransportShape;
  readonly resolutionTimeout?: Duration.Input;
  /** Sends the replacement notice and waits for the parent authorization. */
  readonly authorize: (
    event: SupervisorReplacingMessage,
  ) => Effect.Effect<void, SupervisorStartError>;
  /** Reclaims the deterministic endpoint after the captured owner disappears. */
  readonly reacquire: () => Effect.Effect<
    ControlAcquisition,
    | InvalidControlOwnershipIdError
    | ControlBindError
    | ControlTransportError
    | ControlProtocolError
    | ControlProtocolMismatchError
    | ControlAddressConflictError,
    Scope.Scope
  >;
}

export interface SupervisorReplacementResult {
  readonly acquisition: ControlAcquisition;
  readonly effectiveConfigInput: DaemonConfigInput;
  readonly oldSessionEnded: true;
  readonly attachedOwnerWasStopping: boolean;
}

const runtimeSelectionForLaunch = (launch: ManagedStackLaunch): StackRuntimeSelection =>
  launch.mode === "native"
    ? { mode: "native", containerRuntime: null }
    : { mode: "docker", containerRuntime: launch.containerRuntime };

const persistedPortField = (key: string): PortField | undefined => {
  switch (key) {
    case "api.port":
      return "apiPort";
    case "db.port":
      return "dbPort";
    case "edge_runtime.inspector_port":
      return "edgeRuntimeInspectorPort";
    case "local_smtp.port":
      return "mailpitPort";
    case "local_smtp.smtp_port":
      return "mailpitSmtpPort";
    case "local_smtp.pop3_port":
      return "mailpitPop3Port";
    case "studio.port":
      return "studioPort";
    case "analytics.port":
      return "analyticsPort";
    case "db.pooler.port":
      return "poolerPort";
    default:
      return undefined;
  }
};

const isServiceName = (value: string): value is ServiceName =>
  SERVICE_NAMES.some((service) => service === value);

const isCatalogDefaultServiceConfig = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  return Object.keys(value).every((key) => key === "version");
};

export const applyNativeDefaults = (config: DaemonConfigInput): DaemonConfigInput => {
  const servicePolicies = { ...config.servicePolicies };
  for (const service of SERVICE_NAMES) {
    const metadata = SERVICE_CATALOG[service];
    if (
      metadata.runtimeSupport === "docker-only" &&
      servicePolicies[service] === undefined &&
      isCatalogDefaultServiceConfig(config[metadata.configKey])
    ) {
      servicePolicies[service] = "off";
    }
  }
  return { ...config, servicePolicies };
};

/** Persisted exclusions are authoritative only for an upgrade replacement. */
const applyPersistedExclusions = (
  config: DaemonConfigInput,
  launch: ManagedStackLaunch,
): DaemonConfigInput => {
  const servicePolicies = { ...config.servicePolicies };
  for (const excluded of launch.excludedServices ?? []) {
    if (isServiceName(excluded)) servicePolicies[excluded] = "off";
  }
  return { ...config, servicePolicies };
};

const preflightError = (
  context: SupervisorReplacementContext,
  detail: string,
): UpgradePreflightError =>
  new UpgradePreflightError({
    stackId: context.stackId,
    oldBuildId: context.oldOwner.observedStatus.daemonBuildId,
    newBuildId: context.input.buildIdentity.buildId,
    detail,
  });

const causeMessage = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  if (
    typeof cause === "object" &&
    cause !== null &&
    "detail" in cause &&
    typeof cause.detail === "string"
  ) {
    return cause.detail;
  }
  return typeof cause === "string" ? cause : String(cause);
};

const preflight = (
  context: SupervisorReplacementContext,
): Effect.Effect<
  DaemonConfigInput,
  UpgradePreflightError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const existing = yield* context.manager
      .inspectStack(context.stackId)
      .pipe(Effect.mapError((cause) => preflightError(context, causeMessage(cause))));
    if (existing === undefined)
      return yield* Effect.fail(preflightError(context, "Managed stack document is missing"));

    const persistedRuntime = runtimeSelectionForLaunch(existing.launch);
    yield* validateStackRuntime(persistedRuntime).pipe(
      Effect.mapError((cause) => preflightError(context, causeMessage(cause))),
    );

    const withExclusions = applyPersistedExclusions(context.configInput, existing.launch);
    const effectiveConfigInput =
      persistedRuntime.mode === "native" && context.configInput.mode === undefined
        ? applyNativeDefaults(withExclusions)
        : withExclusions;
    yield* portRequestsForConfig(effectiveConfigInput, { runtime: persistedRuntime }).pipe(
      Effect.mapError((cause) => preflightError(context, causeMessage(cause))),
    );

    const paths = yield* managedStackPathsEffect(context.input.stateRoot, existing.id).pipe(
      Effect.mapError((cause) => preflightError(context, causeMessage(cause))),
    );
    const syntheticPorts: Partial<Record<PortField, number>> = {};
    for (const assignment of existing.ports) {
      const field = persistedPortField(assignment.key);
      if (field !== undefined) syntheticPorts[field] = assignment.port;
    }
    const activeFields = portFieldsForConfigInput({
      ...effectiveConfigInput,
      mode: persistedRuntime.mode,
    });
    for (const [index, field] of activeFields.entries()) {
      if (syntheticPorts[field] === undefined)
        syntheticPorts[field] = PORT_CATALOG[field].preferred ?? 60_000 + index;
    }
    yield* resolveConfig(
      {
        ...effectiveConfigInput,
        projectDir: effectiveConfigInput.projectDir ?? context.input.workspacePath,
        mode: persistedRuntime.mode,
      },
      {
        runtime: persistedRuntime,
        stackRoot: paths.root,
        runtimeRoot: paths.runtime,
        ports: syntheticPorts,
      },
    ).pipe(Effect.mapError((cause) => preflightError(context, causeMessage(cause))));
    return effectiveConfigInput;
  });

/**
 * Performs the complete incompatible-owner transaction. The outer supervisor
 * retains only IPC/listener ownership and startup composition concerns.
 */
export const replaceIncompatibleOwner = (
  context: SupervisorReplacementContext,
): Effect.Effect<
  SupervisorReplacementResult,
  | UpgradePreflightError
  | SupervisorStartError
  | StopTimeout
  | ControlTransportError
  | ControlProtocolError
  | ControlProtocolMismatchError
  | ControlAddressConflictError
  | InvalidControlOwnershipIdError
  | ControlBindError
  | DaemonUpgradeRequired,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    if (context.input.incompatibleOwnerPolicy === "fail") {
      return yield* Effect.fail(
        new DaemonUpgradeRequired({
          stackId: context.stackId,
          oldCliVersion: context.oldOwner.observedStatus.daemonCliVersion,
          oldBuildId: context.oldOwner.observedStatus.daemonBuildId,
          newCliVersion: context.input.buildIdentity.cliVersion,
          newBuildId: context.input.buildIdentity.buildId,
        }),
      );
    }
    const effectiveConfigInput = yield* preflight(context);
    const attachedOwnerWasStopping = context.oldOwner.observedStatus.state === "stopping";
    yield* context.authorize({
      type: "replacing",
      stackId: context.stackId,
      oldCliVersion: context.oldOwner.observedStatus.daemonCliVersion,
      oldBuildId: context.oldOwner.observedStatus.daemonBuildId,
      newCliVersion: context.input.buildIdentity.cliVersion,
      newBuildId: context.input.buildIdentity.buildId,
    });
    const client = makeControlClient(context.controlTransport);
    yield* client
      .stopSession(
        context.oldOwner.endpoint,
        context.oldOwner.observedStatus.ownershipId,
        context.oldOwner.observedStatus.ownerSessionId,
      )
      .pipe(
        Effect.timeoutOrElse({
          duration: context.resolutionTimeout ?? "30 seconds",
          orElse: () =>
            client
              .readOwner(context.oldOwner.endpoint, context.oldOwner.observedStatus.ownershipId)
              .pipe(
                Effect.flatMap((status) =>
                  Effect.fail(
                    new StopTimeout({
                      endpoint: context.oldOwner.endpoint.url,
                      ownerSessionId: context.oldOwner.observedStatus.ownerSessionId,
                      lastState:
                        status.ownerSessionId === context.oldOwner.observedStatus.ownerSessionId
                          ? status.state
                          : context.oldOwner.observedStatus.state,
                    }),
                  ),
                ),
                Effect.catch(() =>
                  Effect.fail(
                    new StopTimeout({
                      endpoint: context.oldOwner.endpoint.url,
                      ownerSessionId: context.oldOwner.observedStatus.ownerSessionId,
                      lastState: context.oldOwner.observedStatus.state,
                    }),
                  ),
                ),
              ),
        }),
      );
    const acquisition = yield* context.reacquire().pipe(
      Effect.timeout(context.resolutionTimeout ?? "30 seconds"),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new SupervisorStartError({
            message: "Timed out waiting for incompatible daemon replacement",
          }),
        ),
      ),
    );
    return { acquisition, effectiveConfigInput, oldSessionEnded: true, attachedOwnerWasStopping };
  });

export { runtimeSelectionForLaunch };
