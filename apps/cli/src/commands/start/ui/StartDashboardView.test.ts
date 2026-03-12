import { describe, expect, test } from "vitest";
import { ConnectionInfo } from "./ConnectionInfo.tsx";

function state(name: string, status: string) {
  return {
    name,
    status,
    pid: null,
    exitCode: null,
    restartCount: 0,
    startedAt: null,
    error: null,
  } as any;
}

function collectNodes(node: unknown): Array<unknown> {
  if (node == null || typeof node === "boolean") {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap(collectNodes);
  }
  if (typeof node !== "object") {
    return [node];
  }
  if ("props" in node) {
    const props = (node as { props?: { children?: unknown } }).props;
    return [node, ...collectNodes(props?.children)];
  }
  return [node];
}

describe("StartDashboardView", () => {
  test("renders the starting status without connection info", async () => {
    const dashboardModule = await import("./StartDashboard.tsx");
    expect("StartDashboardView" in dashboardModule).toBe(true);
    if (!("StartDashboardView" in dashboardModule)) return;

    const element = dashboardModule.StartDashboardView({
      states: [state("postgres", "Starting")],
      info: null,
      showConnectionInfo: false,
      phase: "starting",
      statusLine: "⏳ Starting...",
    });
    const nodes = collectNodes(element);

    expect(nodes).toContain("⏳ Starting...");
    expect(
      nodes.some(
        (node) =>
          typeof node === "object" && node !== null && (node as any).type === ConnectionInfo,
      ),
    ).toBe(false);
  });

  test("renders the failed status without connection info", async () => {
    const dashboardModule = await import("./StartDashboard.tsx");
    expect("StartDashboardView" in dashboardModule).toBe(true);
    if (!("StartDashboardView" in dashboardModule)) return;

    const element = dashboardModule.StartDashboardView({
      states: [state("postgres", "Failed")],
      info: {
        url: "http://127.0.0.1:54321",
        dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        publishableKey: "pk",
        secretKey: "sk",
        anonJwt: "anon",
        serviceRoleJwt: "service-role",
        dockerContainerNames: [],
        serviceEndpoints: {},
      },
      showConnectionInfo: false,
      phase: "failed",
      statusLine: "❌ startup failed",
    });
    const nodes = collectNodes(element);

    expect(nodes).toContain("❌ startup failed");
    expect(
      nodes.some(
        (node) =>
          typeof node === "object" && node !== null && (node as any).type === ConnectionInfo,
      ),
    ).toBe(false);
  });
});
