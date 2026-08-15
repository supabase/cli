import { describe, expect, it } from "vitest";
import type { ManagedWorkspaceDiscovery } from "./discovery.ts";
import { benignConcurrentRegistration } from "./workspace-settlement.ts";

const report = (overrides: Partial<ManagedWorkspaceDiscovery> = {}): ManagedWorkspaceDiscovery => ({
  state: "unregistered",
  workspace: {
    checkoutKind: "git",
    canonicalPath: "/workspace",
    workspaceRoot: "/workspace",
    projectIdentityLocation: "/workspace/.git",
    checkoutIdentityLocation: "/workspace/.git",
  },
  context: { kind: "branch", branch: "main" },
  contextDescriptor: { kind: "branch", locator: "main" },
  identity: {},
  folderToGitClaims: [],
  stacks: [],
  locations: [],
  activeOperations: [],
  conflicts: [],
  warnings: [],
  recoveryOperations: [],
  ...overrides,
});

describe("benignConcurrentRegistration", () => {
  it("accepts a same-topology healthy winner", () => {
    const before = report();
    const after = report({
      state: "healthy",
      identity: { projectId: "project", checkoutId: "checkout", contextId: "context" },
    });
    expect(benignConcurrentRegistration(before, after)).toBe(true);
  });

  it("accepts monotonic partial identity publication", () => {
    const before = report();
    const after = report({ identity: { projectId: "project" } });
    expect(benignConcurrentRegistration(before, after)).toBe(true);
  });

  it("accepts a same-workspace new-checkout reservation", () => {
    const before = report();
    const after = report({
      state: "transitioning",
      activeTransition: {
        id: "transition",
        kind: "new-checkout",
        phase: "reserved",
        path: "/workspace",
        projectIdentityLocation: "/workspace/.git",
        createdAt: "2026-08-15T00:00:00.000Z",
        updatedAt: "2026-08-15T00:00:00.000Z",
      },
    });
    expect(benignConcurrentRegistration(before, after)).toBe(true);
  });

  it("rejects topology changes and non-monotonic identities", () => {
    expect(
      benignConcurrentRegistration(
        report(),
        report({ workspace: { ...report().workspace, workspaceRoot: "/moved" } }),
      ),
    ).toBe(false);
    expect(
      benignConcurrentRegistration(
        report({ identity: { projectId: "project" } }),
        report({ identity: { projectId: "different-project" } }),
      ),
    ).toBe(false);
  });
});
