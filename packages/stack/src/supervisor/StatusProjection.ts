import { Cause, Effect, Match, Predicate } from "effect";
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
    const observed: ReadonlyArray<ObservedWorkload> = Predicate.isTagged(
      observedStatus,
      "available",
    )
      ? observedStatus.workloads
      : [];
    const observationAvailable = Predicate.isTagged(observedStatus, "available");
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
      const cleanupError = Predicate.isTagged(control, "cleanup-failed")
        ? Cause.pretty(control.cause)
        : undefined;
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
  return Match.value(control).pipe(
    Match.when({ _tag: "stopped" }, () =>
      state.desiredLifecycle === "unconfigured" ? ("unconfigured" as const) : ("stopped" as const),
    ),
    Match.when({ _tag: "running" }, () => "running" as const),
    Match.when({ _tag: "starting", prior: { _tag: "running" } }, () => "running" as const),
    Match.when({ _tag: "starting" }, () => "starting" as const),
    Match.tag("stopping", "start-recovery", "stop-required", () => "stopping" as const),
    Match.tag("destroying", "destroy-required", () => "destroying" as const),
    Match.exhaustive,
  );
};
