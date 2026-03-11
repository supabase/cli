import type { ServiceState } from "@supabase/stack";

/**
 * Internal services that should not appear in the dashboard.
 * Maps internal service name → parent service name.
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
 * Filter out internal services (postgres-init) and adjust
 * parent service status to reflect the init/migrate phase.
 *
 * - While postgres-init is running → postgres shows "Initializing"
 * - Once the internal service completes (Stopped) → parent shows its own status
 */
export function toDisplayStates(raw: ReadonlyArray<ServiceState>): ReadonlyArray<ServiceState> {
  const byName = new Map(raw.map((s) => [s.name, s]));

  return raw
    .filter((s) => !(s.name in internalServices))
    .map((s) => {
      // Find if this service has an internal init/migrate step
      for (const [internal, parent] of Object.entries(internalServices)) {
        if (parent !== s.name) continue;
        const initState = byName.get(internal);
        if (!initState) continue;

        // Internal service still in progress → override parent status
        if (initState.status !== "Stopped" && initState.status !== "Failed") {
          return { ...s, status: parentPendingStatus[internal]! } as ServiceState;
        }

        // Internal service failed → propagate failure to parent
        if (initState.status === "Failed") {
          return { ...s, status: "Failed", error: initState.error } as ServiceState;
        }
      }
      return s;
    });
}
