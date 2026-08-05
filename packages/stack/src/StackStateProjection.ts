import type { ServiceState as RawServiceState } from "@supabase/process-compose";
import { Equal } from "effect";
import {
  StackServiceState,
  type StackServiceStatus,
  fromRawServiceState,
} from "./StackServiceState.ts";

interface StackServiceProjectionSpec {
  readonly visibility: "public" | "internal";
  readonly owner?: string;
  readonly ownerStatusWhileActive?: StackServiceStatus;
}

export type StackServiceProjectionCatalog = ReadonlyMap<string, StackServiceProjectionSpec>;

function isHelperActive(state: RawServiceState): boolean {
  return state.desired === "running" && state.status !== "Stopped" && state.status !== "Failed";
}

function projectPublicState(
  raw: RawServiceState,
  rawByName: ReadonlyMap<string, RawServiceState>,
  catalog: StackServiceProjectionCatalog,
): StackServiceState {
  if (raw.desired === "inactive" && (raw.status === "Pending" || raw.status === "Stopped")) {
    return new StackServiceState({ ...fromRawServiceState(raw), status: "Dormant" });
  }

  const ownerHelpers = [...rawByName.values()].filter((candidate) => {
    const spec = catalog.get(candidate.name);
    return (
      spec?.visibility === "internal" && spec.owner === raw.name && candidate.desired === "running"
    );
  });

  const failedHelper = ownerHelpers.find((helper) => helper.status === "Failed");
  if (failedHelper !== undefined) {
    return new StackServiceState({
      name: raw.name,
      status: "Failed",
      pid: raw.pid,
      exitCode: raw.exitCode,
      restartCount: raw.restartCount,
      startedAt: raw.startedAt,
      error: failedHelper.error ?? raw.error,
    });
  }

  if (raw.status === "Failed") {
    return fromRawServiceState(raw);
  }

  const activeHelper = ownerHelpers.find(isHelperActive);
  if (activeHelper !== undefined) {
    const helperSpec = catalog.get(activeHelper.name);
    return new StackServiceState({
      name: raw.name,
      status: helperSpec?.ownerStatusWhileActive ?? raw.status,
      pid: raw.pid,
      exitCode: raw.exitCode,
      restartCount: raw.restartCount,
      startedAt: raw.startedAt,
      error: raw.error,
    });
  }

  return fromRawServiceState(raw);
}

export function projectStackStates(
  rawStates: ReadonlyArray<RawServiceState>,
  catalog: StackServiceProjectionCatalog,
): ReadonlyArray<StackServiceState> {
  const rawByName = new Map(rawStates.map((state) => [state.name, state] as const));

  return rawStates
    .filter((state) => (catalog.get(state.name)?.visibility ?? "public") === "public")
    .map((state) => projectPublicState(state, rawByName, catalog));
}

export function projectStackState(
  name: string,
  rawStates: ReadonlyArray<RawServiceState>,
  catalog: StackServiceProjectionCatalog,
): StackServiceState | undefined {
  return projectStackStates(rawStates, catalog).find((state) => state.name === name);
}

export function changedProjectedStates(
  previous: ReadonlyMap<string, StackServiceState>,
  next: ReadonlyArray<StackServiceState>,
): ReadonlyArray<StackServiceState> {
  return next.filter((state) => !Equal.equals(previous.get(state.name), state));
}
