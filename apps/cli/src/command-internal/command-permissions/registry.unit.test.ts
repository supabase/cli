import { describe, expect, it } from "vitest";

import { applicableOperations, permissionsFor } from "./registry.ts";
import type { CommandPermissions } from "./model.ts";

describe("applicableOperations", () => {
  const mapped = (
    operations: Extract<CommandPermissions, { status: "mapped" }>["operations"],
  ): Extract<CommandPermissions, { status: "mapped" }> => ({
    status: "mapped",
    operations,
    noApiEffectFlags: [],
  });

  it("drops entries whose when condition doesn't hold for the given activeFlags", () => {
    const permissions = mapped([
      { operationId: "v1-run-a-query", kind: "required", when: [{ flag: "linked" }] },
      { operationId: "v1-list-all-secrets", kind: "required" },
    ]);
    expect(applicableOperations(permissions, []).map((e) => e.operationId)).toEqual([
      "v1-list-all-secrets",
    ]);
    expect(applicableOperations(permissions, ["linked"]).map((e) => e.operationId)).toEqual([
      "v1-run-a-query",
      "v1-list-all-secrets",
    ]);
  });

  it("keeps a required entry with no context over a required entry that has one, for the same operationId", () => {
    const permissions = mapped([
      {
        operationId: "v1-get-project",
        kind: "required",
        context: "only on a cache miss",
        source: "linked-project-cache",
      },
      { operationId: "v1-get-project", kind: "required" },
    ]);
    const result = applicableOperations(permissions, []);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ operationId: "v1-get-project", kind: "required" });
  });

  it("keeps a required entry over a best-effort entry for the same operationId, regardless of order", () => {
    const bestEffortFirst = mapped([
      { operationId: "v1-get-project", kind: "best-effort", source: "linked-project-cache" },
      { operationId: "v1-get-project", kind: "required" },
    ]);
    const requiredFirst = mapped([
      { operationId: "v1-get-project", kind: "required" },
      { operationId: "v1-get-project", kind: "best-effort", source: "linked-project-cache" },
    ]);
    expect(applicableOperations(bestEffortFirst, [])).toEqual([
      { operationId: "v1-get-project", kind: "required" },
    ]);
    expect(applicableOperations(requiredFirst, [])).toEqual([
      { operationId: "v1-get-project", kind: "required" },
    ]);
  });
});

describe("permissionsFor", () => {
  it("returns undefined for a path with no declared mapping", () => {
    expect(permissionsFor("not-a-real-command")).toBeUndefined();
  });
});
