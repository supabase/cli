import { Duration, Effect, FileSystem, Match, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { validateStackRuntime, type StackRuntimeSelection } from "./ContainerRuntime.ts";
import type { SupervisorStartMessage } from "./SupervisorProtocol.ts";
import {
  observeControlStopForSession,
  type ControlProbe,
  type ControlTransportShape,
} from "./managed/control.ts";
import type { ManagedStackManagerShape } from "./managed/manager.ts";
import { managedStackPathsEffect } from "./managed/paths.ts";
import type { ManagedStackLaunch } from "./managed/document.ts";
import { PORT_CATALOG, PORT_FIELDS, type PortField } from "./PortCatalog.ts";
import { reservePortSet } from "./PortAllocator.ts";
import { portFieldsForConfigInput } from "./ServicePorts.ts";
import { SERVICE_CATALOG, SERVICE_NAMES } from "./ServiceCatalog.ts";
import { expandExcludedServices } from "./ServiceExclusions.ts";
import {
  portRequestsForConfig,
  rawServiceEnabled,
  resolveConfig,
  type DaemonConfigInput,
} from "./StackConfigResolver.ts";
import { versionsForConfig } from "./StackBuilder.ts";
import { StopTimeout, UpgradePreflightError, UpgradeRestartError } from "./errors.ts";
import { isControlSupervisorStatus } from "./DaemonProtocol.ts";

interface UpgradeRestartContext {
  readonly stackId: string;
  readonly oldCliVersion: string;
  readonly oldOwner?: ControlProbe;
  readonly input: SupervisorStartMessage;
  readonly configInput: DaemonConfigInput;
  readonly manager: ManagedStackManagerShape;
  readonly controlTransport: ControlTransportShape;
  readonly resolutionTimeout?: Duration.Input;
}

export interface UpgradeRestartResult {
  readonly effectiveConfigInput: DaemonConfigInput;
  readonly launch: ManagedStackLaunch;
}

const UPGRADE_RESTART_PHASE_TIMEOUT = Duration.seconds(30);

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

const enableService = (
  config: DaemonConfigInput,
  service: (typeof SERVICE_NAMES)[number],
  version: string | undefined,
): DaemonConfigInput => {
  const versionField = version === undefined ? {} : { version };
  switch (service) {
    case "postgres":
      return { ...config, postgres: { ...config.postgres, ...versionField } };
    case "postgrest":
      return {
        ...config,
        postgrest: { ...(config.postgrest === false ? {} : config.postgrest), ...versionField },
      };
    case "auth":
      return {
        ...config,
        auth: { ...(config.auth === false ? {} : config.auth), ...versionField },
      };
    case "edge-runtime":
      return {
        ...config,
        edgeRuntime: {
          ...(config.edgeRuntime === false ? {} : config.edgeRuntime),
          ...versionField,
        },
      };
    case "realtime":
      return {
        ...config,
        realtime: { ...(config.realtime === false ? {} : config.realtime), ...versionField },
      };
    case "storage":
      return {
        ...config,
        storage: { ...(config.storage === false ? {} : config.storage), ...versionField },
      };
    case "imgproxy":
      return {
        ...config,
        imgproxy: { ...(config.imgproxy === false ? {} : config.imgproxy), ...versionField },
      };
    case "mailpit":
      return {
        ...config,
        mailpit: { ...(config.mailpit === false ? {} : config.mailpit), ...versionField },
      };
    case "pgmeta":
      return {
        ...config,
        pgmeta: { ...(config.pgmeta === false ? {} : config.pgmeta), ...versionField },
      };
    case "studio":
      return {
        ...config,
        studio: { ...(config.studio === false ? {} : config.studio), ...versionField },
      };
    case "analytics":
      return {
        ...config,
        analytics: { ...(config.analytics === false ? {} : config.analytics), ...versionField },
      };
    case "vector":
      return {
        ...config,
        vector: { ...(config.vector === false ? {} : config.vector), ...versionField },
      };
    case "pooler":
      return {
        ...config,
        pooler: { ...(config.pooler === false ? {} : config.pooler), ...versionField },
      };
  }
};

/** Persisted exclusions are authoritative; restored services keep their pinned version. */
const applyPersistedLaunch = (
  config: DaemonConfigInput,
  persisted: ManagedStackLaunch,
  requested: SupervisorStartMessage["launch"],
): DaemonConfigInput => {
  let effective = config;
  const restartRequestExclusions = expandExcludedServices(requested?.excludedServices ?? []);
  const persistedExclusions = expandExcludedServices(persisted.excludedServices ?? []);
  const servicesToEnable = new Set<(typeof SERVICE_NAMES)[number]>();
  for (const service of restartRequestExclusions) {
    if (persisted.mode !== "native" || SERVICE_CATALOG[service].runtimeSupport !== "docker-only") {
      servicesToEnable.add(service);
    }
  }
  for (const service of SERVICE_NAMES) {
    if (
      !persistedExclusions.has(service) &&
      persisted.versions[service] !== undefined &&
      rawServiceEnabled(config, service)
    ) {
      servicesToEnable.add(service);
    }
  }
  for (const service of servicesToEnable) {
    if (!persistedExclusions.has(service)) {
      effective = enableService(effective, service, persisted.versions[service]);
    }
  }
  const servicePolicies = { ...effective.servicePolicies };
  for (const service of servicesToEnable) {
    if (!persistedExclusions.has(service) && servicePolicies[service] === "off") {
      delete servicePolicies[service];
    }
  }
  for (const excluded of persistedExclusions) {
    servicePolicies[excluded] = "off";
  }
  return { ...effective, servicePolicies };
};

const preflightError = (context: UpgradeRestartContext, detail: string): UpgradePreflightError =>
  new UpgradePreflightError({
    stackId: context.stackId,
    oldCliVersion: context.oldCliVersion,
    newCliVersion: context.input.cliVersion,
    detail,
  });

const causeMessage = (cause: unknown): string => {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "detail" in cause &&
    typeof cause.detail === "string"
  ) {
    return cause.detail;
  }
  if (
    typeof cause === "object" &&
    cause !== null &&
    "cause" in cause &&
    cause.cause !== undefined &&
    cause.cause !== cause
  ) {
    return causeMessage(cause.cause);
  }
  if (cause instanceof Error && cause.message.length > 0) return cause.message;
  return typeof cause === "string" ? cause : String(cause);
};

const preflight = (
  context: UpgradeRestartContext,
): Effect.Effect<
  UpgradeRestartResult,
  UpgradePreflightError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const existing = yield* context.manager
      .inspectStack(context.stackId)
      .pipe(Effect.mapError((cause) => preflightError(context, causeMessage(cause))));
    if (existing === undefined)
      return yield* preflightError(context, "Managed stack document is missing");

    const persistedRuntime = runtimeSelectionForLaunch(existing.launch);
    yield* validateStackRuntime(persistedRuntime).pipe(
      Effect.mapError((cause) => preflightError(context, causeMessage(cause))),
    );

    const withExclusions = applyPersistedLaunch(
      context.configInput,
      existing.launch,
      context.input.launch,
    );
    const effectiveConfigInput =
      persistedRuntime.mode === "native" && context.configInput.mode === undefined
        ? applyNativeDefaults(withExclusions)
        : withExclusions;
    const portRequests = yield* portRequestsForConfig(effectiveConfigInput, {
      runtime: persistedRuntime,
    }).pipe(Effect.mapError((cause) => preflightError(context, causeMessage(cause))));
    const activeFields = portFieldsForConfigInput({
      ...effectiveConfigInput,
      mode: persistedRuntime.mode,
    });
    const activeFieldSet = new Set(activeFields);
    yield* context.manager
      .validateManagedPortReservations({
        stackId: context.stackId,
        portDocument: {
          ...context.input.portIntents,
          activeFields,
          disabledFields: PORT_FIELDS.filter(
            (field) => PORT_CATALOG[field].persistence === "sticky" && !activeFieldSet.has(field),
          ),
        },
        persisted: existing.ports,
        preservePersisted: true,
      })
      .pipe(Effect.mapError((cause) => preflightError(context, causeMessage(cause))));

    const persistedFields = new Set(
      existing.ports.flatMap((assignment) => {
        const field = persistedPortField(assignment.key);
        return field === undefined ? [] : [field];
      }),
    );
    const newlyActivatedExactPorts = portRequests.filter(
      (request) =>
        request.selection.kind === "exact" &&
        PORT_CATALOG[request.field].persistence === "sticky" &&
        !persistedFields.has(request.field),
    );
    if (newlyActivatedExactPorts.length > 0) {
      yield* Effect.acquireUseRelease(
        reservePortSet(newlyActivatedExactPorts),
        () => Effect.void,
        (lease) => lease.releaseAll,
      ).pipe(Effect.mapError((cause) => preflightError(context, causeMessage(cause))));
    }

    const paths = yield* managedStackPathsEffect(context.input.stateRoot, existing.id).pipe(
      Effect.mapError((cause) => preflightError(context, causeMessage(cause))),
    );
    const syntheticPorts: Partial<Record<PortField, number>> = {};
    for (const assignment of existing.ports) {
      const field = persistedPortField(assignment.key);
      if (field !== undefined) syntheticPorts[field] = assignment.port;
    }
    for (const [index, field] of activeFields.entries()) {
      if (syntheticPorts[field] === undefined)
        syntheticPorts[field] = PORT_CATALOG[field].preferred ?? 60_000 + index;
    }
    const resolvedConfig = yield* resolveConfig(
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
    return {
      effectiveConfigInput,
      launch: {
        ...existing.launch,
        versions: {
          ...versionsForConfig(resolvedConfig),
          ...existing.launch.versions,
        },
      },
    };
  });

/**
 * Parent-side replacement transaction. It proves the persisted launch is
 * startable before asking the exact incompatible session to stop, then reads
 * and validates the launch again before a fresh child is spawned.
 */
export const prepareUpgradeReplacement = (
  context: UpgradeRestartContext,
): Effect.Effect<
  UpgradeRestartResult,
  UpgradePreflightError | StopTimeout | UpgradeRestartError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const phaseTimeout = context.resolutionTimeout ?? UPGRADE_RESTART_PHASE_TIMEOUT;
    const preflightCurrentLaunch = () =>
      preflight(context).pipe(
        Effect.timeout(phaseTimeout),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(preflightError(context, "Timed out preflighting upgrade restart")),
        ),
      );
    const initial = yield* preflightCurrentLaunch();
    const oldOwner = context.oldOwner;
    if (oldOwner === undefined) return initial;
    if (!isControlSupervisorStatus(oldOwner.status)) {
      return yield* new UpgradeRestartError({
        stackId: context.stackId,
        newCliVersion: context.input.cliVersion,
        detail: `Managed stack is busy with ${oldOwner.status.operation} maintenance`,
      });
    }
    const oldStatus = oldOwner.status;
    yield* observeControlStopForSession(
      oldOwner.endpoint,
      oldStatus.ownershipId,
      oldStatus.ownerSessionId,
      context.controlTransport,
      "replacement",
      phaseTimeout,
    ).pipe(
      Effect.flatMap((result) =>
        Match.valueTags(result, {
          ended: () => Effect.void,
          replaced: () => Effect.void,
          "still-live": ({ lastState }) =>
            Effect.fail(
              new StopTimeout({
                endpoint: oldOwner.endpoint.url,
                ownerSessionId: oldStatus.ownerSessionId,
                lastState,
              }),
            ),
        }),
      ),
      Effect.mapError((error) =>
        error instanceof StopTimeout
          ? error
          : new UpgradeRestartError({
              stackId: context.stackId,
              newCliVersion: context.input.cliVersion,
              detail: causeMessage(error),
            }),
      ),
    );
    return yield* preflightCurrentLaunch().pipe(
      Effect.mapError(
        (error) =>
          new UpgradeRestartError({
            stackId: context.stackId,
            newCliVersion: context.input.cliVersion,
            detail: causeMessage(error),
          }),
      ),
    );
  });

export { runtimeSelectionForLaunch };
