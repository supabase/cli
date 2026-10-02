/**
 * Computes the `@supabase/config` release plan via semantic-release's dry-run
 * JS API — the version-computation half of an otherwise independent release
 * pipeline; actual publishing happens in later, separate workflow steps (see
 * `.github/workflows/release-config.yml`).
 *
 * Commit analysis and release-notes generation are scoped to this package's own
 * history via `./semantic-release-path-filter.ts` (see that file for why a
 * monorepo-wide run would be wrong here).
 *
 * Always exits 0 once semantic-release completes, whether or not a release is
 * due — a non-zero exit means this script itself failed to run the plan, not
 * that no release was found.
 */

import { appendFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { PACKAGE_PATH_PREFIX } from "./semantic-release-path-filter.ts";

// Not `import.meta.dir`: that Bun-ism doesn't survive vitest's module
// transform, and this module is imported by its unit test.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface ConfigPackageJson {
  readonly name: string;
  readonly private?: boolean;
}

interface ReleaseDuePlan {
  readonly due: true;
  readonly version: string;
  readonly bumpType: string;
  readonly notes: string;
  readonly isPrivate: boolean;
}

/**
 * `semantic-release`'s dry-run API returns bare `false` with no reason of its
 * own; {@link resolveHeadDivergence} is what tells "genuinely nothing to
 * release" apart from "this HEAD can't release" so the summary can say which.
 */
export type NoReleaseReason = "no-releasable-commits" | "branch-behind-remote" | "branch-diverged";

export interface NoReleasePlan {
  readonly due: false;
  readonly reason: NoReleaseReason;
}

export type ReleasePlan = ReleaseDuePlan | NoReleasePlan;

// The sole entry feeds both semantic-release's `branches` option and the git
// comparison below — one place to change the release branch, not two.
const RELEASE_BRANCHES = ["develop"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readPackageJson(): Promise<ConfigPackageJson> {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const parsed: unknown = JSON.parse(await Bun.file(packageJsonPath).text());
  if (
    !isRecord(parsed) ||
    typeof parsed.name !== "string" ||
    (parsed.private !== undefined && typeof parsed.private !== "boolean")
  ) {
    throw new Error(
      `${packageJsonPath} is malformed: expected a string "name" and an optional boolean "private".`,
    );
  }
  return { name: parsed.name, private: parsed.private };
}

async function runGit(
  args: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { exitCode, stdout: stdout.trim() };
}

type HeadDivergence = "current" | "behind-remote" | "diverged" | "unknown";

/**
 * Compares `HEAD` against `origin/${RELEASE_BRANCHES[0]}` to tell a stale
 * checkout (semantic-release refuses to plan behind the branch it publishes
 * from) apart from a checkout that's actually current. Falls back to
 * `"unknown"` — never blocking the plan — when the remote ref can't be
 * resolved, e.g. a local-only clone with no `origin` fetched.
 */
async function resolveHeadDivergence(cwd: string): Promise<HeadDivergence> {
  const remoteRef = `origin/${RELEASE_BRANCHES[0]}`;
  const remote = await runGit(["rev-parse", "--verify", remoteRef], cwd);
  if (remote.exitCode !== 0 || remote.stdout === "") {
    return "unknown";
  }

  const head = await runGit(["rev-parse", "HEAD"], cwd);
  if (head.exitCode !== 0 || head.stdout === "") {
    return "unknown";
  }
  if (head.stdout === remote.stdout) {
    return "current";
  }

  const ancestor = await runGit(["merge-base", "--is-ancestor", "HEAD", remoteRef], cwd);
  if (ancestor.exitCode === 0) {
    return "behind-remote";
  }
  if (ancestor.exitCode === 1) {
    return "diverged";
  }
  return "unknown";
}

/**
 * Runs semantic-release in dry-run mode against this package's own history.
 * `result === false` means it refused to plan — either no releasable commits
 * since the last `config-v*` tag, or (semantic-release logs this itself, but
 * doesn't say so in its return value) this checkout is behind or diverged
 * from the branch it releases from; {@link resolveHeadDivergence} tells them
 * apart via git rather than parsing its log output. Otherwise
 * `result.nextRelease` carries the computed version, bump type, and notes.
 */
async function computeReleasePlan(isPrivate: boolean): Promise<ReleasePlan> {
  const { default: semanticRelease } = await import("semantic-release");
  const result = await semanticRelease(
    {
      branches: [...RELEASE_BRANCHES],
      tagFormat: "config-v${version}",
      dryRun: true,
      plugins: ["./scripts/semantic-release-path-filter.ts"],
    },
    { cwd: packageRoot, env: process.env },
  );

  if (result === false) {
    const divergence = await resolveHeadDivergence(packageRoot);
    return {
      due: false,
      reason:
        divergence === "behind-remote"
          ? "branch-behind-remote"
          : divergence === "diverged"
            ? "branch-diverged"
            : "no-releasable-commits",
    };
  }

  // With no config-v* tag on the branch, semantic-release would cut 1.0.0
  // analyzed from the entire monorepo history, so the release notes would be a
  // changelog of every commit that ever touched packages/config/. Refuse until a
  // baseline tag exists (see AGENTS.md "One-time setup"); the escape hatch is
  // for an intentional first cut.
  if (!result.lastRelease.gitTag && !process.env.CONFIG_RELEASE_ALLOW_NO_BASELINE) {
    throw new Error(
      "no config-v* baseline tag found on this branch: semantic-release would release " +
        `${result.nextRelease.version} with notes generated from the entire monorepo history. ` +
        "Push a baseline tag first (e.g. config-v0.1.0 — see packages/config/AGENTS.md), or set " +
        "CONFIG_RELEASE_ALLOW_NO_BASELINE=1 to proceed deliberately.",
    );
  }

  const version = result.nextRelease.version;
  // The version flows into `npm pkg set`, a git tag name, and a GH release
  // title — refuse anything that isn't the plain stable x.y.z this
  // stable-only train can produce.
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`computed version "${version}" is not a plain x.y.z stable version.`);
  }

  return {
    due: true,
    version,
    bumpType: result.nextRelease.type,
    notes: result.nextRelease.notes ?? "",
    isPrivate,
  };
}

async function appendGithubOutput(lines: readonly string[]): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  await appendFile(outputPath, `${lines.join("\n")}\n`);
}

async function appendStepSummary(markdown: string): Promise<void> {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  await appendFile(summaryPath, `${markdown}\n`);
}

/**
 * A fence long enough that no backtick run inside `content` can close it.
 * Notes are commit-message-derived (PR titles/bodies, including external
 * contributors'), so rendering them as live markdown would let a crafted
 * commit message forge parts of this summary.
 */
function fenceFor(content: string): string {
  const longestRun = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longestRun + 1));
}

export function toGithubOutputLines(plan: ReleasePlan): string[] {
  const shouldRelease = plan.due && !plan.isPrivate;
  const blockedOnPrivate = plan.due && plan.isPrivate;
  return [
    `should_release=${shouldRelease}`,
    `version=${plan.due ? plan.version : ""}`,
    `npm_tag=latest`,
    `blocked_on_private=${blockedOnPrivate}`,
  ];
}

/**
 * Shared between the GH step summary and local-run logging so both surfaces
 * point at the same fix: re-run from the branch tip, not the pinned commit.
 */
function noReleaseMessage(reason: NoReleaseReason): string {
  const branch = RELEASE_BRANCHES[0];
  switch (reason) {
    case "no-releasable-commits":
      return (
        `No release: no releasable commits touching \`${PACKAGE_PATH_PREFIX}\` since the last ` +
        "`config-v*` tag."
      );
    case "branch-behind-remote":
      return (
        `No release: this run's commit is behind \`origin/${branch}\`'s current tip, so ` +
        "semantic-release refused to plan — a re-run pinned to an older commit can never " +
        `release. Re-run the workflow from the tip of \`${branch}\` instead.`
      );
    case "branch-diverged":
      return (
        `No release: this run's commit has diverged from \`origin/${branch}\`'s current tip, ` +
        "so semantic-release refused to plan. Re-run the workflow from the tip of " +
        `\`${branch}\` instead.`
      );
  }
}

export function renderStepSummary(plan: ReleasePlan): string {
  const lines: string[] = ["## @supabase/config release plan", ""];

  if (!plan.due) {
    lines.push(noReleaseMessage(plan.reason));
    return lines.join("\n");
  }

  lines.push(`**${plan.version}** (\`${plan.bumpType}\` release).`, "");

  if (plan.isPrivate) {
    lines.push(
      "> [!WARNING]",
      "> `packages/config` is `private: true`, so publishing is blocked. This run validated the " +
        "release pipeline only; nothing will be published.",
      "",
    );
  }

  if (plan.notes) {
    const notes = plan.notes.trim();
    const fence = fenceFor(notes);
    lines.push(
      "<details><summary>Release notes (markdown source)</summary>",
      "",
      `${fence}markdown`,
      notes,
      fence,
      "",
      "</details>",
    );
  }

  return lines.join("\n");
}

function renderLocalPlan(plan: ReleasePlan): string {
  if (!plan.due) {
    return `[release-plan] ${noReleaseMessage(plan.reason)}`;
  }
  const privateNote = plan.isPrivate ? " (blocked: packages/config is private: true)" : "";
  return `[release-plan] @supabase/config would release ${plan.version} (${plan.bumpType})${privateNote}.`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "notes-out": { type: "string" } } });
  const notesOutPath = values["notes-out"];

  const packageJson = await readPackageJson();
  const isPrivate = packageJson.private === true;

  const plan = await computeReleasePlan(isPrivate);

  if (plan.due && notesOutPath) {
    // Guarantee the trailing newline: the notes end up as a GH release
    // body_path file, and a missing final newline is the kind of upstream
    // formatting detail nothing else pins.
    await Bun.write(notesOutPath, plan.notes.endsWith("\n") ? plan.notes : `${plan.notes}\n`);
  }

  if (process.env.GITHUB_OUTPUT) {
    await appendGithubOutput(toGithubOutputLines(plan));
  } else {
    console.log(renderLocalPlan(plan));
  }

  await appendStepSummary(renderStepSummary(plan));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`[release-plan] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
