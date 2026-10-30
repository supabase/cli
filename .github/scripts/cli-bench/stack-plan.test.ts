import { describe, expect, test } from "bun:test";
import { planStackRun, readManifest, type PlanDeps, type PlanInput } from "./stack-plan.ts";

const REPO = "supabase/cli";
const manifest = readManifest(
  JSON.stringify({
    workloads: [
      { id: "start", runtime: "docker", estimatedSeconds: 400 },
      { id: "db-reset", runtime: "docker", estimatedSeconds: 400 },
      { id: "stack-start-native", runtime: "native", estimatedSeconds: 100 },
    ],
  }),
);

const input = (overrides: Partial<PlanInput> = {}): PlanInput => ({
  event: "workflow_dispatch",
  workloads: "all",
  runtime: "both",
  base: "merge-base",
  refName: "feature/x",
  repository: REPO,
  manifest,
  ...overrides,
});

const deps = (overrides: Partial<PlanDeps> = {}): PlanDeps => ({
  latestRelease: async () => "v3.0.0",
  openPullRequests: async () => [{ number: 12, headRepoFullName: REPO }],
  ...overrides,
});

describe("planStackRun", () => {
  test("measures everything against the latest stable release on a schedule, with no pull request", async () => {
    const plan = await planStackRun(
      input({ event: "schedule", workloads: "", runtime: "", base: "", refName: "develop" }),
      deps(),
    );

    expect(plan).toMatchObject({
      workloads: "all",
      runtime: "both",
      baseKind: "release",
      baseTag: "v3.0.0",
      prNumber: "",
      runLightweight: true,
      runIntegration: true,
    });
  });

  test("attaches a merge-base run to the branch's single open pull request", async () => {
    const plan = await planStackRun(input(), deps());

    expect(plan).toMatchObject({ baseKind: "merge-base", baseTag: "", prNumber: "12" });
  });

  test.each([
    ["no open pull request", [] as Array<{ number: number; headRepoFullName: string }>],
    [
      "two open pull requests",
      [
        { number: 1, headRepoFullName: REPO },
        { number: 2, headRepoFullName: REPO },
      ],
    ],
    ["a pull request from a fork", [{ number: 3, headRepoFullName: "someone/cli" }]],
  ])("attaches no pull request when the branch has %s", async (_name, pulls) => {
    const plan = await planStackRun(input(), deps({ openPullRequests: async () => pulls }));

    expect(plan.prNumber).toBe("");
  });

  test("leaves the pull request comment alone for a run against a release tag", async () => {
    const plan = await planStackRun(input({ base: "v3.0.0" }), deps());

    expect(plan).toMatchObject({ baseKind: "release", baseTag: "v3.0.0", prNumber: "" });
  });

  test.each(["main", "v3", "v3.0.0; rm -rf /", "$(id)", "../v3.0.0"])(
    "rejects the base %p",
    async (base) => {
      await expect(planStackRun(input({ base }), deps())).rejects.toThrow("Unsupported base");
    },
  );

  test.each([
    ["lightweight", { runLightweight: true, runIntegration: false, shards: 0 }],
    ["integration-heavy", { runLightweight: false, runIntegration: true, shards: 3 }],
    ["all", { runLightweight: true, runIntegration: true, shards: 3 }],
  ])("plans shards for workloads=%s", async (workloads, expected) => {
    const plan = await planStackRun(input({ workloads }), deps());

    expect(plan.runLightweight).toBe(expected.runLightweight);
    expect(plan.runIntegration).toBe(expected.runIntegration);
    expect(plan.matrix.include).toHaveLength(expected.shards);
  });

  test("keeps only the requested runtime's shards", async () => {
    const plan = await planStackRun(input({ runtime: "native" }), deps());

    expect(plan.matrix.include).toEqual([
      expect.objectContaining({ runtime: "native", workloads: "stack-start-native" }),
    ]);
  });

  test("rejects an unknown runtime or workloads choice", async () => {
    await expect(planStackRun(input({ runtime: "podman" }), deps())).rejects.toThrow("runtime");
    await expect(planStackRun(input({ workloads: "none" }), deps())).rejects.toThrow("workloads");
  });
});
