import { PORT_CATALOG } from "../PortCatalog.ts";
import type { ConfigPortKey, PortField } from "../PortCatalog.ts";
import type { PortReservationRequest, PortSelection } from "../PortAllocator.ts";
import type { ManagedPortAssignment, ManagedPortRequest, ManagedPortIntent } from "./model.ts";
import type { ManagedStackDocumentLifecycle } from "./document.ts";

/** A persisted assignment used when applying the managed port conflict matrix. */
export interface ManagedPortReservation {
  readonly stackId: string;
  readonly stackName?: string;
  readonly lifecycle: ManagedStackDocumentLifecycle;
  readonly assignment: ManagedPortAssignment;
}

/**
 * Automatic assignments are exclusive for every persisted stack. Exact
 * assignments may coexist while the owner is stopped or failed, but never
 * while the owner occupies its ports.
 */
export const managedPortReservationsConflict = (
  incomingStackId: string,
  incoming: ManagedPortAssignment,
  owner: ManagedPortReservation,
): boolean =>
  incomingStackId !== owner.stackId &&
  incoming.port === owner.assignment.port &&
  (incoming.intent === "automatic" ||
    owner.assignment.intent === "automatic" ||
    owner.lifecycle === "running" ||
    owner.lifecycle === "starting" ||
    owner.lifecycle === "deleting");

export interface ManagedDurablePortPlanEntry {
  readonly field: PortField;
  readonly key: ConfigPortKey;
  readonly intent: ManagedPortIntent;
  readonly selection: PortSelection;
  readonly newlyAllocatedAutomatic: boolean;
}

export interface ManagedPortPlan {
  readonly durable: ReadonlyArray<ManagedDurablePortPlanEntry>;
  readonly runtimeOnly: ReadonlyArray<PortReservationRequest>;
  readonly inactiveAssignments: ReadonlyArray<ManagedPortAssignment>;
}

export interface ManagedPortPlanInput {
  readonly activeFields: ReadonlyArray<PortField>;
  readonly disabledFields?: ReadonlyArray<PortField>;
  readonly intents: ReadonlyArray<ManagedPortRequest>;
  readonly persisted?: ReadonlyArray<ManagedPortAssignment>;
}

const automaticSelection = (preferred: number | undefined): PortSelection =>
  preferred === undefined ? { kind: "automatic" } : { kind: "automatic", preferred };

/** Build sticky durable selections and runtime-only requests from resolved intent. */
export const planManagedPorts = (input: ManagedPortPlanInput): ManagedPortPlan => {
  const persisted = input.persisted ?? [];
  const persistedByKey = new Map(persisted.map((assignment) => [assignment.key, assignment]));
  const intentsByField = new Map(input.intents.map((request) => [request.field, request]));
  const activeKeys = new Set<ManagedPortAssignment["key"]>();
  const durable: Array<ManagedDurablePortPlanEntry> = [];
  const runtimeOnly: Array<PortReservationRequest> = [];

  for (const field of input.activeFields) {
    const entry = PORT_CATALOG[field];
    if (entry.persistence === "sticky" && entry.configKey !== undefined) {
      activeKeys.add(entry.configKey);
      const configured = intentsByField.get(field);
      const persistedAssignment = persistedByKey.get(entry.configKey);
      const intent = configured?.intent ?? "automatic";
      if (configured?.intent === "exact") {
        durable.push({
          field,
          key: entry.configKey,
          intent: configured.intent,
          selection: { kind: "exact", port: configured.port },
          newlyAllocatedAutomatic: false,
        });
      } else if (persistedAssignment !== undefined) {
        durable.push({
          field,
          key: entry.configKey,
          intent,
          selection: { kind: "exact", port: persistedAssignment.port },
          newlyAllocatedAutomatic: false,
        });
      } else {
        durable.push({
          field,
          key: entry.configKey,
          intent,
          selection: automaticSelection(entry.preferred),
          newlyAllocatedAutomatic: true,
        });
      }
      continue;
    }

    if (entry.persistence === "runtime") {
      runtimeOnly.push({ field, selection: automaticSelection(entry.preferred) });
    }
  }

  const disabledKeys = new Set(
    (input.disabledFields ?? []).flatMap((field) => {
      const key = PORT_CATALOG[field].configKey;
      return key === undefined ? [] : [key];
    }),
  );
  return {
    durable,
    runtimeOnly,
    inactiveAssignments: persisted
      .filter((assignment) => !activeKeys.has(assignment.key))
      .map((assignment) =>
        disabledKeys.has(assignment.key) ? assignment : { ...assignment, intent: "automatic" },
      ),
  };
};
