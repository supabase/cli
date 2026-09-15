import { Cause, Effect } from "effect";
import { CAPABILITY_NAMES, type CapabilityName } from "../public/Capability.ts";
import type { StackId } from "../public/StackId.ts";
import {
  PORT_FIELD_PROTOCOL,
  type ArtifactPreparationStatus,
  type StackStatus,
} from "../public/Status.ts";
import type { ObservedWorkload } from "../runtime/RuntimeDriver.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import type { SupervisorSnapshot } from "./SupervisorState.ts";
import { publicCapabilityState } from "./CapabilityState.ts";

export type ActualPhase = "stopped" | "starting" | "running" | "stopping" | "destroying";

export type ObservedStatus =
  | { readonly _tag: "available"; readonly workloads: ReadonlyArray<ObservedWorkload> }
  | { readonly _tag: "unavailable" };

const observedForCapability = (
  name: CapabilityName,
  observed: ReadonlyArray<ObservedWorkload>,
): ReadonlyArray<ObservedWorkload> =>
  observed.filter((entry) => entry.workloadId.startsWith(`${name}:`));

/** Projects one authoritative Supervisor snapshot while preserving observed runtime failures. */
export const statusForSnapshot = (
  id: StackId,
  state: PersistedStackState,
  observedStatus: ObservedStatus,
  snapshot: SupervisorSnapshot,
  artifacts: ReadonlyArray<ArtifactPreparationStatus> = [],
): Effect.Effect<StackStatus> =>
  Effect.sync(() => {
    const definition = state.definition;
    const observed: ReadonlyArray<ObservedWorkload> =
      observedStatus._tag === "available" ? observedStatus.workloads : [];
    const observationAvailable = observedStatus._tag === "available";
    const capabilities = CAPABILITY_NAMES.map((name) => {
      const control = snapshot.capabilities.get(name);
      const configured = definition?.capabilities[name];
      const observedEntries = observedForCapability(name, observed);
      const observedFailure = observedEntries.find((entry) => entry.state === "failed");
      const projected =
        control === undefined
          ? configured === undefined || !configured.enabled
            ? "disabled"
            : "stopped"
          : snapshot.stack._tag === "starting" &&
              snapshot.stack.prior._tag === "stopped" &&
              control._tag === "starting" &&
              control.completion._tag === "workload"
            ? "starting"
            : publicCapabilityState(control);
      const observedStarting = observedEntries.some((entry) => entry.state === "starting");
      const observedUnready = observedEntries.some((entry) => entry.state !== "ready");
      const capability =
        observedFailure !== undefined && projected === "ready"
          ? "failed"
          : projected === "ready" && observedStarting
            ? "starting"
            : projected === "ready" &&
                observationAvailable &&
                observedEntries.length === 0 &&
                configured?.enabled === true
              ? "stopped"
              : projected === "ready" && observedEntries.length > 0 && observedUnready
                ? "stopped"
                : projected;
      const cleanupError =
        control?._tag === "cleanup-failed" ? Cause.pretty(control.cause) : undefined;
      return {
        name,
        activation:
          configured?.activation ?? (name === "database" ? ("eager" as const) : ("lazy" as const)),
        state: capability,
        ...(cleanupError === undefined && observedFailure?.error === undefined
          ? {}
          : { error: cleanupError ?? observedFailure?.error }),
      };
    });
    const versions: Partial<Record<CapabilityName, string>> = {};
    if (definition !== undefined)
      for (const name of CAPABILITY_NAMES) versions[name] = definition.capabilities[name].version;
    const endpoints = state.ports.reduce<StackStatus["endpoints"]>((result, assignment) => {
      const protocol = PORT_FIELD_PROTOCOL[assignment.field];
      const listener = definition?.listeners[assignment.field];
      return {
        ...result,
        [assignment.field]: {
          protocol,
          address: listener?.address ?? "127.0.0.1",
          port: assignment.port,
          url: `${protocol}://${listener?.address ?? "127.0.0.1"}:${assignment.port}`,
        },
      };
    }, {});
    return {
      id,
      lifecycle: publicPhase(snapshot.stack, state),
      desiredLifecycle: state.desiredLifecycle,
      runtime: state.runtime,
      endpoints,
      versions,
      capabilities,
      artifacts,
    } satisfies StackStatus;
  });

const publicPhase = (
  control: SupervisorSnapshot["stack"],
  state: PersistedStackState,
): StackStatus["lifecycle"] => {
  switch (control._tag) {
    case "stopped":
      return state.desiredLifecycle === "unconfigured" ? "unconfigured" : "stopped";
    case "running":
      return "running";
    case "starting":
      return control.prior._tag === "running" ? "running" : "starting";
    case "stopping":
    case "start-recovery":
    case "stop-required":
      return "stopping";
    case "destroying":
    case "destroy-required":
      return "destroying";
  }
};
