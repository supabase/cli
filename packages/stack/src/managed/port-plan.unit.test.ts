import { describe, expect, it } from "vitest";
import { resolvePortIntents } from "./port-intent.ts";
import { planManagedPorts, type ManagedDurablePortPlanEntry } from "./port-plan.ts";

describe("planManagedPorts", () => {
  it("pins persisted automatic and exact-to-omitted durable values", () => {
    const activeFields = ["apiPort", "dbPort"] as const;
    const intents = resolvePortIntents({ activeFields, document: {} });

    expect(
      planManagedPorts({
        activeFields,
        intents,
        persisted: [
          { key: "api.port", port: 55001, intent: "automatic" },
          { key: "db.port", port: 55002, intent: "exact" },
        ],
      }),
    ).toEqual({
      durable: [
        {
          field: "apiPort",
          key: "api.port",
          intent: "automatic",
          selection: { kind: "exact", port: 55001 },
          newlyAllocatedAutomatic: false,
        },
        {
          field: "dbPort",
          key: "db.port",
          intent: "automatic",
          selection: { kind: "exact", port: 55002 },
          newlyAllocatedAutomatic: false,
        },
      ],
      runtimeOnly: [],
      inactiveAssignments: [],
    });
  });

  it("preserves inactive durable assignments without requesting sockets", () => {
    const activeFields = [] as const;
    const intents = resolvePortIntents({ activeFields, document: {} });

    expect(
      planManagedPorts({
        activeFields,
        intents,
        persisted: [{ key: "studio.port", port: 55003, intent: "exact" }],
      }),
    ).toEqual({
      durable: [],
      runtimeOnly: [],
      inactiveAssignments: [{ key: "studio.port", port: 55003, intent: "exact" }],
    });
  });

  it("creates runtime-only automatic requests for active keyless fields", () => {
    const activeFields = ["authPort"] as const;
    const intents = resolvePortIntents({ activeFields, document: {} });

    expect(planManagedPorts({ activeFields, intents, persisted: [] })).toEqual({
      durable: [],
      runtimeOnly: [{ field: "authPort", selection: { kind: "automatic" } }],
      inactiveAssignments: [],
    });
  });

  it("keeps exact requests exact instead of adding an automatic fallback", () => {
    const activeFields = ["apiPort"] as const;
    const intents = resolvePortIntents({
      activeFields,
      document: { api: { port: 55004 } },
    });

    const [entry] = planManagedPorts({ activeFields, intents, persisted: [] }).durable;
    const durable: ManagedDurablePortPlanEntry | undefined = entry;
    expect(durable).toEqual({
      field: "apiPort",
      key: "api.port",
      intent: "exact",
      selection: { kind: "exact", port: 55004 },
      newlyAllocatedAutomatic: false,
    });
  });

  it("prefers the catalog candidate for a new automatic durable field", () => {
    const activeFields = ["apiPort"] as const;
    const intents = resolvePortIntents({ activeFields, document: {} });

    expect(planManagedPorts({ activeFields, intents, persisted: [] }).durable).toEqual([
      {
        field: "apiPort",
        key: "api.port",
        intent: "automatic",
        selection: { kind: "automatic", preferred: 54321 },
        newlyAllocatedAutomatic: true,
      },
    ]);
  });
});
