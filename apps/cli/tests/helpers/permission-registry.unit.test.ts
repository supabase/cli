import { describe, expect, it } from "vitest";

import type { CommandPermissions } from "../../src/command-internal/command-permissions/model.ts";
import { applicableOperations, declaredPermissions } from "./permission-registry.ts";

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
    expect(applicableOperations(permissions, {}).map((e) => e.operationId)).toEqual([
      "v1-list-all-secrets",
    ]);
    expect(applicableOperations(permissions, { linked: true }).map((e) => e.operationId)).toEqual([
      "v1-run-a-query",
      "v1-list-all-secrets",
    ]);
  });

  it("applies a value condition only when the flag's value is one it lists", () => {
    const permissions = mapped([
      {
        operationId: "v1-get-security-advisors",
        kind: "required",
        when: [{ flag: "type", oneOf: ["all", "security"] }],
      },
      {
        operationId: "v1-get-performance-advisors",
        kind: "required",
        when: [{ flag: "type", oneOf: ["all", "performance"] }],
      },
    ]);
    const applied = (activeFlags: Parameters<typeof applicableOperations>[1]) =>
      applicableOperations(permissions, activeFlags).map((e) => e.operationId);
    expect(applied({ type: "all" })).toEqual([
      "v1-get-security-advisors",
      "v1-get-performance-advisors",
    ]);
    expect(applied({ type: "security" })).toEqual(["v1-get-security-advisors"]);
    expect(applied({ type: true })).toEqual([]);
    expect(applied({})).toEqual([]);
  });

  it("applies a switch condition to the switch's effective value", () => {
    const permissions = mapped([
      {
        operationId: "v1-get-pooler-config",
        kind: "best-effort",
        when: [{ flag: "skip-pooler", is: false }],
      },
    ]);
    const applied = (activeFlags: Parameters<typeof applicableOperations>[1]) =>
      applicableOperations(permissions, activeFlags).map((e) => e.operationId);
    expect(applied({ "skip-pooler": false })).toEqual(["v1-get-pooler-config"]);
    expect(applied({ "skip-pooler": true })).toEqual([]);
    expect(applied({})).toEqual(["v1-get-pooler-config"]);
  });

  it("treats a flag given an empty value as absent", () => {
    const permissions = mapped([
      {
        operationId: "v1-create-login-role",
        kind: "required",
        when: [{ flag: "password", present: false }],
      },
      { operationId: "v1-list-all-projects", kind: "required", when: [{ flag: "project-ref" }] },
    ]);
    const applied = (activeFlags: Parameters<typeof applicableOperations>[1]) =>
      applicableOperations(permissions, activeFlags).map((e) => e.operationId);
    expect(applied({ password: "" })).toEqual(["v1-create-login-role"]);
    expect(applied({ password: "hunter2" })).toEqual([]);
    expect(applied({ password: "x", "project-ref": "" })).toEqual([]);
    expect(applied({ password: "x", "project-ref": "abcdefghijklmnopqrst" })).toEqual([
      "v1-list-all-projects",
    ]);
  });

  describe("database target", () => {
    const entries = [
      { operationId: "v1-run-a-query", kind: "required", when: [{ dbTarget: ["linked"] }] },
      {
        operationId: "v1-get-pooler-config",
        kind: "required",
        when: [{ dbTarget: ["local", "db-url"] }],
      },
    ] as const;
    const applied = (activeFlags: Parameters<typeof applicableOperations>[1]) =>
      applicableOperations(mapped(entries), activeFlags).map((e) => e.operationId);

    it("takes --db-url over --local over --linked", () => {
      expect(applied({ linked: true, local: true, "db-url": true })).toEqual([
        "v1-get-pooler-config",
      ]);
      expect(applied({ linked: true, local: true })).toEqual(["v1-get-pooler-config"]);
      expect(applied({ linked: true })).toEqual(["v1-run-a-query"]);
    });

    it("reads a run with no target flag as the local stack", () => {
      expect(applied({})).toEqual(["v1-get-pooler-config"]);
    });
  });

  describe("selector shape", () => {
    const REF = "abcdefghijklmnopqrst";
    const permissions = mapped([
      { operationId: "v1-list-all-branches", kind: "required", when: [{ selector: ["branch"] }] },
      {
        operationId: "v1-get-pooler-config",
        kind: "required",
        when: [{ selector: ["ref", "branch", "url"] }],
      },
      {
        operationId: "v1-list-all-projects",
        kind: "required",
        when: [{ selector: ["none", "bare"] }],
      },
      { operationId: "v1-get-a-branch-config", kind: "required", when: [{ selector: ["uuid"] }] },
    ]);
    const applied = (activeFlags: Parameters<typeof applicableOperations>[1]) =>
      applicableOperations(permissions, activeFlags).map((e) => e.operationId);

    it("reads a branch UUID as its own shape, apart from a branch name", () => {
      expect(applied({ remote: "6f0b5d2e-3c1a-4f7e-9a58-2b1d4c7e8f90" })).toEqual([
        "v1-get-a-branch-config",
      ]);
    });

    it("reads a --remote value by what it names", () => {
      expect(applied({ remote: true })).toEqual(["v1-list-all-projects"]);
      expect(applied({ remote: "yes" })).toEqual(["v1-list-all-projects"]);
      expect(applied({ remote: REF })).toEqual(["v1-get-pooler-config"]);
      expect(applied({ remote: "feature-x" })).toEqual([
        "v1-list-all-branches",
        "v1-get-pooler-config",
      ]);
      expect(applied({ remote: "postgresql://postgres@localhost:5432/postgres" })).toEqual([
        "v1-get-pooler-config",
      ]);
    });

    it("folds the deprecated aliases into the same shapes", () => {
      expect(applied({ "project-ref": REF })).toEqual(applied({ remote: REF }));
      expect(applied({ "project-id": "feature-x" })).toEqual(applied({ remote: "feature-x" }));
      expect(applied({ "project-ref": "true" })).toEqual(applied({ remote: "feature-x" }));
      expect(applied({ linked: true })).toEqual(applied({ remote: true }));
      expect(applied({ "db-url": "postgresql://postgres@localhost:5432/postgres" })).toEqual(
        applied({ remote: "postgresql://postgres@localhost:5432/postgres" }),
      );
    });

    it("reads no selector, and --local, as none", () => {
      expect(applied({})).toEqual(["v1-list-all-projects"]);
      expect(applied({ local: true })).toEqual(["v1-list-all-projects"]);
    });
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
    const result = applicableOperations(permissions, {});
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
    expect(applicableOperations(bestEffortFirst, {})).toEqual([
      { operationId: "v1-get-project", kind: "required" },
    ]);
    expect(applicableOperations(requiredFirst, {})).toEqual([
      { operationId: "v1-get-project", kind: "required" },
    ]);
  });
});

describe("declaredPermissions", () => {
  it("finds a declared leaf only in the tree that includes it, and reports an absent path as not found", () => {
    expect(declaredPermissions("not-a-real-command")).toEqual({ _tag: "NotFound" });
    expect(declaredPermissions("stack list")).toEqual({ _tag: "NotFound" });
    expect(declaredPermissions("stack list", { stackBackend: "stack" })._tag).toBe("Declared");
  });

  it("reports a command group, which carries no declaration, as undeclared", () => {
    expect(declaredPermissions("db branch")).toEqual({ _tag: "Undeclared" });
  });
});
