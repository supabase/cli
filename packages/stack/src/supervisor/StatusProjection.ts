import { Effect, Schema } from "effect";
import {
  CAPABILITY_NAMES,
  type CapabilityName,
  type CapabilityStatus,
} from "../public/Capability.ts";
import { StackStateInvalidError } from "../public/Errors.ts";
import { StackIdSchema } from "../public/StackId.ts";
import { PORT_FIELD_PROTOCOL, type StackStatus } from "../public/Status.ts";
import type { ObservedWorkload } from "../runtime/RuntimeDriver.ts";
import type { PersistedStackState } from "../state/StackState.ts";

export type ActualPhase = "stopped" | "starting" | "running" | "stopping" | "destroying";

const observedForCapability = (
  name: CapabilityName,
  observed: ReadonlyArray<ObservedWorkload>,
): ReadonlyArray<ObservedWorkload> =>
  observed.filter((entry) => entry.workloadId.startsWith(`${name}:`));

const capabilityState = (
  name: CapabilityName,
  state: PersistedStackState,
  observed: ReadonlyArray<ObservedWorkload>,
  active: ReadonlySet<CapabilityName>,
  phase: ActualPhase,
): CapabilityStatus["state"] => {
  const configured = state.definition?.capabilities[name];
  if (configured === undefined || !configured.enabled) return "disabled";
  if (
    state.desiredLifecycle !== "running" ||
    phase === "stopped" ||
    phase === "stopping" ||
    phase === "destroying"
  )
    return "stopped";
  if (configured.activation === "lazy" && !active.has(name)) return "dormant";
  if (phase === "starting") return "starting";
  const resources = observedForCapability(name, observed);
  if (resources.some((entry) => entry.state === "failed")) return "failed";
  if (resources.some((entry) => entry.state === "starting")) return "starting";
  if (resources.length > 0 && resources.every((entry) => entry.state === "ready")) return "ready";
  return "stopped";
};

const capabilityError = (
  name: CapabilityName,
  observed: ReadonlyArray<ObservedWorkload>,
  state: CapabilityStatus["state"],
): string | undefined => {
  if (state !== "failed") return undefined;
  const failed = observedForCapability(name, observed).filter((entry) => entry.state === "failed");
  if (failed.length === 1) return failed[0]?.error;
  const details = failed.flatMap((entry) =>
    entry.error === undefined ? [] : [`${entry.workloadId}: ${entry.error}`],
  );
  return details.length === 0 ? undefined : details.join("; ");
};

const stackLifecycle = (
  state: PersistedStackState,
  phase: ActualPhase,
): StackStatus["lifecycle"] => {
  if (phase === "stopping") return "stopping";
  if (state.desiredLifecycle === "unconfigured") return "unconfigured";
  if (phase === "destroying" || state.desiredLifecycle === "destroying") return "destroying";
  if (phase === "starting") return "starting";
  if (state.desiredLifecycle === "stopped") return "stopped";
  if (phase === "running") return "running";
  return "stopped";
};

export const statusFor = (
  state: PersistedStackState,
  observed: ReadonlyArray<ObservedWorkload>,
  active: ReadonlySet<CapabilityName>,
  phase: ActualPhase,
): Effect.Effect<StackStatus, StackStateInvalidError> =>
  Schema.decodeEffect(StackIdSchema)(state.identity.stackId).pipe(
    Effect.mapError(
      (error) =>
        new StackStateInvalidError({ message: `Invalid persisted StackId: ${String(error)}` }),
    ),
    Effect.map((id) => {
      const definition = state.definition;
      const capabilities = CAPABILITY_NAMES.map((name) => {
        const capability = capabilityState(name, state, observed, active, phase);
        const error = capabilityError(name, observed, capability);
        return {
          name,
          activation:
            definition?.capabilities[name].activation ?? (name === "database" ? "eager" : "lazy"),
          state: capability,
          ...(error === undefined ? {} : { error }),
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
        lifecycle: stackLifecycle(state, phase),
        desiredLifecycle: state.desiredLifecycle,
        runtime: state.runtime,
        endpoints,
        versions,
        capabilities,
      } satisfies StackStatus;
    }),
  );
