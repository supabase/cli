import { describe, expect, it } from "vitest";
import type { ManagedWorkspaceDiscovery } from "./discovery.ts";
import { discoveryObservation } from "./discovery-observation.ts";

const report = (): ManagedWorkspaceDiscovery => ({
  state: "healthy",
  workspace: {
    checkoutKind: "git",
    canonicalPath: "/workspace",
    workspaceRoot: "/workspace",
    projectIdentityLocation: "/workspace/.git",
    checkoutIdentityLocation: "/workspace/.git",
  },
  context: { kind: "branch", branch: "main" },
  contextDescriptor: { kind: "branch", locator: "main" },
  identity: { projectId: "project", checkoutId: "checkout", contextId: "context" },
  folderToGitClaims: [],
  stacks: [],
  locations: [
    {
      id: "location",
      checkoutId: "checkout",
      canonicalPath: "/workspace",
      state: "active",
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  activeOperations: [],
  conflicts: [],
  warnings: [],
  recoveryOperations: [],
});

describe("discoveryObservation", () => {
  it("does not depend on collection order", () => {
    const first = report();
    const second = {
      ...first,
      locations: [...first.locations].reverse(),
      conflicts: ["later", "earlier"],
      warnings: ["later", "earlier"],
      recoveryOperations: [
        { operation: "newCheckout" as const, path: "/workspace" },
        { operation: "prune" as const, recordIds: ["b", "a"] },
      ],
    };
    const third = {
      ...first,
      conflicts: ["earlier", "later"],
      warnings: ["earlier", "later"],
      recoveryOperations: [
        { operation: "prune" as const, recordIds: ["a", "b"] },
        { operation: "newCheckout" as const, path: "/workspace" },
      ],
    };
    expect(discoveryObservation(second)).toBe(discoveryObservation(third));
  });

  it("changes when recovery-critical fields change", () => {
    const first = report();
    expect(
      discoveryObservation({
        ...first,
        locations: first.locations.map((location) => ({ ...location, state: "blocked" as const })),
      }),
    ).not.toBe(discoveryObservation(first));
    expect(
      discoveryObservation({
        ...first,
        context: { kind: "branch", branch: "release" },
      }),
    ).not.toBe(discoveryObservation(first));
  });
});
