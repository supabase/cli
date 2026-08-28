/**
 * Computes the `@supabase/config` release plan via semantic-release's
 * dry-run JS API (CLI-2233) — the version-computation half of an otherwise
 * independent release pipeline for this package. Actual publishing (npm
 * publish, tag push, GitHub release) happens in later, separate workflow
 * steps; see `.github/workflows/release-config.yml`.
 *
 * Commit analysis and release-notes generation are scoped to this package's
 * own history via `./semantic-release-path-filter.ts` (see that file for
 * why a plain `@semantic-release/commit-analyzer` run over the whole
 * monorepo history would be wrong here).
 *
 * Always exits 0 once semantic-release itself completes, whether or not a
 * release is due — a non-zero exit means this script itself failed to run
 * the plan, not that no release was found.
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

export interface ReleaseDuePlan {
  readonly due: true;
  readonly version: string;
  readonly bumpType: string;
  readonly notes: string;
  readonly isPrivate: boolean;
}

export interface NoReleasePlan {
  readonly due: false;
}

export type ReleasePlan = ReleaseDuePlan | NoReleasePlan;

async function readPackageJson(): Promise<ConfigPackageJson> {
  return JSON.parse(
    await Bun.file(path.join(packageRoot, "package.json")).text(),
  ) as ConfigPackageJson;
}

/**
 * Runs semantic-release in dry-run mode against this package's own history.
 * `result === false` means no releasable commits were found since the last
 * `config-v*` tag (semantic-release already logs why); otherwise
 * `result.nextRelease` carries the computed version, bump type, and notes.
 */
async function computeReleasePlan(isPrivate: boolean): Promise<ReleasePlan> {
  const { default: semanticRelease } = await import("semantic-release");
  const result = await semanticRelease(
    {
      branches: ["develop"],
      tagFormat: "config-v${version}",
      dryRun: true,
      plugins: ["./scripts/semantic-release-path-filter.ts"],
    },
    { cwd: packageRoot, env: process.env },
  );

  if (result === false) {
    return { due: false };
  }

  // With no config-v* tag on the branch, semantic-release would cut 1.0.0
  // analyzed from the ENTIRE monorepo history — the release notes (the human
  // approver's artifact and the public GH release body) would be a changelog
  // of every commit that ever touched packages/config/. Refuse until a
  // baseline tag exists (see AGENTS.md "One-time setup"); the escape hatch is
  // for a deliberate, eyes-open first cut.
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
 * A fence long enough that no backtick run inside `content` can close it —
 * the notes are commit-message-derived (squash-merge messages sourced from PR
 * titles/bodies, including external contributors'), and this summary is the
 * approver's evidence: rendering them as live markdown would let a crafted
 * commit message forge parts of it.
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

export function renderStepSummary(plan: ReleasePlan): string {
  const lines: string[] = ["## @supabase/config release plan", ""];

  if (!plan.due) {
    lines.push(
      `No release: no releasable commits touching \`${PACKAGE_PATH_PREFIX}\` since the last ` +
        "`config-v*` tag.",
    );
    return lines.join("\n");
  }

  lines.push(`**${plan.version}** (\`${plan.bumpType}\` release).`, "");

  if (plan.isPrivate) {
    lines.push(
      "> [!WARNING]",
      "> `packages/config` is still `private: true`, so publishing is blocked — flip it under " +
        "CLI-2169. This run validated the release pipeline only; nothing will be published.",
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
    return (
      `[release-plan] no release due for @supabase/config (no commits touching ` +
      `${PACKAGE_PATH_PREFIX} since the last config-v* tag).`
    );
  }
  const privateNote = plan.isPrivate ? " (blocked: packages/config is still private: true)" : "";
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
