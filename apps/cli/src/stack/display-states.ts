import type { ServiceState } from "@supabase/stack";

/**
 * Internal services that should not appear in CLI status displays.
 * Maps internal service name to the parent service name.
 */
const internalServices: Record<string, string> = {
  "postgres-init": "postgres",
};

/**
 * Status to show on the parent while the internal service is still running.
 */
const parentPendingStatus: Record<string, string> = {
  "postgres-init": "Initializing",
};

/**
 * Filter out internal services (postgres-init) and adjust parent
 * service status to reflect the init or migrate phase.
 *
 * - While postgres-init is running, postgres shows "Initializing"
 * - Once the internal service completes, postgres shows its own status
 */
export function toDisplayStates(raw: ReadonlyArray<ServiceState>): ReadonlyArray<ServiceState> {
  const byName = new Map(raw.map((s) => [s.name, s]));

  return raw
    .filter((s) => !(s.name in internalServices))
    .map((s) => {
      for (const [internal, parent] of Object.entries(internalServices)) {
        if (parent !== s.name) continue;
        const initState = byName.get(internal);
        if (!initState) continue;

        if (initState.status !== "Stopped" && initState.status !== "Failed") {
          return { ...s, status: parentPendingStatus[internal]! } as ServiceState;
        }

        if (initState.status === "Failed") {
          return { ...s, status: "Failed", error: initState.error } as ServiceState;
        }
      }
      return s;
    });
}
