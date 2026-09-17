import { Effect } from "effect";
import { CAPABILITY_NAMES, type CapabilityName } from "../public/Capability.ts";
import type { StackId } from "../public/StackId.ts";
import {
  PORT_FIELD_PROTOCOL,
  type ArtifactPreparationStatus,
  type ServiceStatus,
  type StackStatus,
} from "../public/Status.ts";
import type { PersistedStackState } from "../state/StackState.ts";

/** Projects status from the durable registry when no supervisor is connected. */
export const statusForPersistedState = (
  id: StackId,
  state: PersistedStackState,
  artifacts: ReadonlyArray<ArtifactPreparationStatus> = [],
): Effect.Effect<StackStatus> =>
  Effect.sync(() => {
    const statusForInstance = (instance: PersistedStackState["registry"]["instances"][number]) => {
      const pending = instance.pendingOperation;
      const phase: ServiceStatus["phase"] =
        pending?.kind === "start" || pending?.kind === "restart"
          ? "starting"
          : pending?.kind === "sleep" || pending?.kind === "stop" || pending?.kind === "destroy"
            ? "stopping"
            : instance.intent === "started"
              ? "ready"
              : "stopped";
      const endpoints = state.ports
        .filter(
          (assignment) => assignment.owner === "instance" && assignment.instanceId === instance.id,
        )
        .map((assignment) => {
          const tcp = assignment.binding === "sql" || assignment.binding === "pooler";
          return {
            binding: assignment.binding,
            protocol: tcp ? ("tcp" as const) : ("http" as const),
            address: assignment.address,
            port: assignment.port,
            url: `${tcp ? "tcp" : "http"}://${assignment.address}:${assignment.port}`,
            availability: phase === "ready" ? ("listening" as const) : ("planned" as const),
          };
        });
      return {
        id: instance.id,
        service: instance.service,
        ...(instance.name === undefined ? {} : { name: instance.name }),
        enabled: instance.config.enabled,
        intent: instance.intent,
        phase,
        activation: instance.config.activation,
        ...(pending === null ? {} : { pendingOperation: { id: pending.id, kind: pending.kind } }),
        endpoints,
      } satisfies ServiceStatus;
    };

    const instances = state.registry.instances.map(statusForInstance);
    const defaultStatus = new Map<CapabilityName, ServiceStatus>();
    for (const status of instances)
      if (state.registry.defaultInstanceIds[status.service] === status.id)
        defaultStatus.set(status.service, status);
    const capabilities = CAPABILITY_NAMES.map((name) => {
      const current = defaultStatus.get(name);
      const configured = state.registry.instances.find(
        (instance) =>
          instance.service === name && state.registry.defaultInstanceIds[name] === instance.id,
      );
      const stateValue =
        configured?.config.enabled !== true
          ? ("disabled" as const)
          : current?.phase === "ready"
            ? ("ready" as const)
            : current?.phase === "starting"
              ? ("starting" as const)
              : current?.phase === "stopping"
                ? ("stopping" as const)
                : current?.phase === "dormant"
                  ? ("dormant" as const)
                  : ("stopped" as const);
      return {
        name,
        activation: current?.activation ?? (name === "database" ? "eager" : "lazy"),
        state: stateValue,
      };
    });
    const api = state.ports.find(
      (assignment) => assignment.owner === "stack" && assignment.binding === "api",
    );
    const endpoints =
      api === undefined
        ? {}
        : {
            api: {
              protocol: PORT_FIELD_PROTOCOL.api,
              address: api.address,
              port: api.port,
              url: `${PORT_FIELD_PROTOCOL.api}://${api.address}:${api.port}`,
            },
          };
    const desiredLifecycle = state.registry.instances.some(
      (instance) => instance.intent === "started",
    )
      ? "running"
      : state.registry.instances.length === 0
        ? "unconfigured"
        : "stopped";
    return {
      id,
      lifecycle: desiredLifecycle,
      desiredLifecycle,
      runtime: state.runtime,
      endpoints,
      versions: Object.fromEntries(
        state.registry.instances
          .filter((instance) => state.registry.defaultInstanceIds[instance.service] === instance.id)
          .map((instance) => [instance.service, instance.config.version]),
      ),
      capabilities,
      artifacts,
      instances,
    } satisfies StackStatus;
  });
