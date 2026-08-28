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
import { parseArgs } from "node:util";

import { PACKAGE_PATH_PREFIX } from "./semantic-release-path-filter.ts";

const packageRoot = path.resolve(import.meta.dir, "..");

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

interface NoReleasePlan {
  readonly due: false;
}

type ReleasePlan = ReleaseDuePlan | NoReleasePlan;

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

  return {
    due: true,
    version: result.nextRelease.version,
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

function renderStepSummary(plan: ReleasePlan): string {
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
    lines.push(
      "<details><summary>Release notes</summary>",
      "",
      plan.notes.trim(),
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
  const shouldRelease = plan.due && !plan.isPrivate;
  const blockedOnPrivate = plan.due && plan.isPrivate;
  const version = plan.due ? plan.version : "";

  if (plan.due && notesOutPath) {
    await Bun.write(notesOutPath, plan.notes);
  }

  if (process.env.GITHUB_OUTPUT) {
    await appendGithubOutput([
      `should_release=${shouldRelease}`,
      `version=${version}`,
      `npm_tag=latest`,
      `blocked_on_private=${blockedOnPrivate}`,
    ]);
  } else {
    console.log(renderLocalPlan(plan));
  }

  await appendStepSummary(renderStepSummary(plan));
}

try {
  await main();
} catch (error) {
  console.error(`[release-plan] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
