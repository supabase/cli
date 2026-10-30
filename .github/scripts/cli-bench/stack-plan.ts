/**
 * Planner for the stack benchmark workflow: resolves what a run measures and against which base,
 * attaches the run to its pull request, and splits the workloads into shards.
 *
 * A scheduled run measures everything against the latest stable release. A dispatched run uses its
 * inputs; its base is the merge base with `develop` unless a release tag is given. Only a
 * merge-base run on a branch with exactly one open pull request into `develop` from this
 * repository updates that pull request's comment. Needs read access only.
 * Run in CI as: `bun .github/scripts/cli-bench/stack-plan.ts`.
 */
import { appendFileSync, readFileSync } from "node:fs";

import { packShards, type PackedWorkload } from "../../../apps/cli/scripts/bench-pack.ts";
import { githubFetch, requireEnv } from "./github.ts";

export const WORKLOAD_CHOICES = ["all", "lightweight", "integration-heavy"] as const;
export const RUNTIME_CHOICES = ["both", "docker", "native"] as const;
export type WorkloadChoice = (typeof WORKLOAD_CHOICES)[number];
export type RuntimeChoice = (typeof RUNTIME_CHOICES)[number];

const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const MANIFEST = "apps/cli/bench/workloads.stack.json";

export interface PlanInput {
  event: string;
  workloads: string;
  runtime: string;
  base: string;
  refName: string;
  repository: string;
  manifest: ReadonlyArray<PackedWorkload>;
}

export interface PullRequestRef {
  number: number;
  headRepoFullName: string;
}

export interface PlanDeps {
  /** Tag of the latest stable release. */
  latestRelease: () => Promise<string>;
  /** Open pull requests into `develop` whose head is `refName`. */
  openPullRequests: (refName: string) => Promise<ReadonlyArray<PullRequestRef>>;
}

export interface StackPlan {
  workloads: WorkloadChoice;
  runtime: RuntimeChoice;
  baseKind: "merge-base" | "release";
  /** The release tag compared against; empty for a merge-base run. */
  baseTag: string;
  /** Pull request whose comment this run updates; empty when none. */
  prNumber: string;
  runLightweight: boolean;
  runIntegration: boolean;
  matrix: { include: ReadonlyArray<Record<string, unknown>> };
}

const isChoice = <T extends string>(choices: ReadonlyArray<T>, value: string): value is T =>
  (choices as ReadonlyArray<string>).includes(value);

/** What a run measures, against what, and which shards run it. Throws on invalid inputs. */
export async function planStackRun(input: PlanInput, deps: PlanDeps): Promise<StackPlan> {
  const scheduled = input.event === "schedule";
  const workloads = scheduled ? "all" : input.workloads;
  const runtime = scheduled ? "both" : input.runtime;
  if (!isChoice(WORKLOAD_CHOICES, workloads)) {
    throw new Error(`Unsupported workloads "${workloads}".`);
  }
  if (!isChoice(RUNTIME_CHOICES, runtime)) throw new Error(`Unsupported runtime "${runtime}".`);

  let baseKind: StackPlan["baseKind"] = "merge-base";
  let baseTag = "";
  if (scheduled) {
    baseKind = "release";
    baseTag = await deps.latestRelease();
  } else if (input.base !== "merge-base") {
    baseKind = "release";
    baseTag = input.base;
  }
  if (baseKind === "release" && !RELEASE_TAG.test(baseTag)) {
    throw new Error(
      `Unsupported base "${baseTag}"; use merge-base or a release tag such as v3.0.0.`,
    );
  }

  let prNumber = "";
  if (!scheduled && baseKind === "merge-base") {
    const candidates = (await deps.openPullRequests(input.refName)).filter(
      (pr) => pr.headRepoFullName === input.repository,
    );
    if (candidates.length === 1) prNumber = String(candidates[0]?.number);
  }

  const runIntegration = workloads === "all" || workloads === "integration-heavy";
  const wanted = (shardRuntime: string) => runtime === "both" || runtime === shardRuntime;
  const include = runIntegration
    ? packShards(input.manifest)
        .filter((shard) => wanted(shard.runtime))
        .map((shard) => ({ ...shard, workloads: shard.workloads.join(",") }))
    : [];
  return {
    workloads,
    runtime,
    baseKind,
    baseTag,
    prNumber,
    runLightweight: workloads === "all" || workloads === "lightweight",
    runIntegration,
    matrix: { include },
  };
}

/** Reads the `id`, `runtime` and `estimatedSeconds` fields of a workload manifest. */
export function readManifest(text: string): ReadonlyArray<PackedWorkload> {
  const parsed: unknown = JSON.parse(text);
  const list = (parsed as { workloads?: unknown }).workloads;
  if (!Array.isArray(list)) throw new Error("The workload manifest has no workloads list.");
  return list.map((entry: Record<string, unknown>) => ({
    id: String(entry.id),
    ...(entry.runtime === "docker" || entry.runtime === "native" ? { runtime: entry.runtime } : {}),
    ...(typeof entry.estimatedSeconds === "number"
      ? { estimatedSeconds: entry.estimatedSeconds }
      : {}),
  }));
}

async function main(): Promise<void> {
  const token = requireEnv("GITHUB_TOKEN");
  const repository = requireEnv("GITHUB_REPOSITORY");
  const [owner = ""] = repository.split("/");
  const base = `https://api.github.com/repos/${repository}`;

  const plan = await planStackRun(
    {
      event: requireEnv("EVENT_NAME"),
      workloads: process.env.INPUT_WORKLOADS ?? "all",
      runtime: process.env.INPUT_RUNTIME ?? "both",
      base: process.env.INPUT_BASE ?? "merge-base",
      refName: requireEnv("REF_NAME"),
      repository,
      manifest: readManifest(readFileSync(MANIFEST, "utf8")),
    },
    {
      latestRelease: async () => {
        const latest = (await (await githubFetch(`${base}/releases/latest`, token)).json()) as {
          tag_name: string;
        };
        return latest.tag_name;
      },
      openPullRequests: async (refName) => {
        const url =
          `${base}/pulls?state=open&base=develop&per_page=100` +
          `&head=${encodeURIComponent(`${owner}:${refName}`)}`;
        const pulls = (await (await githubFetch(url, token)).json()) as Array<{
          number: number;
          head: { repo: { full_name: string } | null };
        }>;
        return pulls.map((pr) => ({
          number: pr.number,
          headRepoFullName: pr.head.repo?.full_name ?? "",
        }));
      },
    },
  );

  const outputs: Record<string, string> = {
    workloads: plan.workloads,
    runtime: plan.runtime,
    base_kind: plan.baseKind,
    base_tag: plan.baseTag,
    pr_number: plan.prNumber,
    run_lightweight: String(plan.runLightweight),
    run_integration: String(plan.runIntegration),
    has_shards: String(plan.matrix.include.length > 0),
    matrix: JSON.stringify(plan.matrix),
  };
  console.log(
    `CLI stack benchmark plan: workloads=${plan.workloads} runtime=${plan.runtime} ` +
      `base=${plan.baseKind === "release" ? plan.baseTag : "merge-base"} pr=${plan.prNumber || "none"} ` +
      `shards=${plan.matrix.include.length}`,
  );
  appendFileSync(
    requireEnv("GITHUB_OUTPUT"),
    Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
  );
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
