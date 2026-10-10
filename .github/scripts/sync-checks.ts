import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type GitRunner, gitOrThrow } from "./promotion-shared.ts";
import type { AgentDecision, AgentResolution } from "./sync-agent.ts";

/** Outcome of the quality checks on the merged tree, after at most one agent fix. */
export interface CheckResult {
  passed: boolean;
  /** Files the formatter or the agent changed, committed on top of the merge. */
  fixes: AgentResolution["files"];
  /** Choices the agent made while fixing the checks. */
  decisions: AgentDecision[];
  /** Check output still failing, capped. */
  remaining?: string;
}

export type Checker = () => { passed: boolean; output: string };

/** Returns the agent's fix for the failing check output, or the reason it produced none. */
export type CheckFixer = (output: string) => Promise<AgentResolution | string>;

const MAX_CHECK_OUTPUT = 20_000;
const FORMATTED = "Formatted with the repository formatter.";

/** Stages the tracked-file changes a check made (the formatter's) and removes the files it generated. */
function keepCheckChanges(git: GitRunner): void {
  gitOrThrow(git, ["add", "-u"]);
  gitOrThrow(git, ["clean", "-fdq"]);
}

function dropUnstaged(git: GitRunner): void {
  gitOrThrow(git, ["checkout", "-q", "--", "."]);
  gitOrThrow(git, ["clean", "-fdq"]);
}

/**
 * Runs the checks and, when they fail, asks `fix` for one round of edits; a rejected fix is dropped. Changes already
 * staged, the formatter's, and the agent's are committed on top of HEAD as one follow-up commit; `fixes` lists only
 * the formatter's and the fix's.
 */
export async function checkAndFix(
  git: GitRunner,
  check: Checker,
  fix: CheckFixer,
  message: string,
): Promise<CheckResult> {
  const staged = (): string[] =>
    gitOrThrow(git, ["diff", "--cached", "-z", "--name-only"]).split("\0").filter(Boolean);
  const stagedBefore = new Set(staged());
  let last = check();
  keepCheckChanges(git);
  let edits: AgentResolution["files"] = [];
  let decisions: AgentDecision[] = [];
  if (!last.passed) {
    const outcome = await fix(last.output.slice(-MAX_CHECK_OUTPUT));
    if (
      typeof outcome === "string" ||
      outcome.status === "unresolved" ||
      outcome.deletedFiles.length > 0
    ) {
      dropUnstaged(git);
    } else {
      gitOrThrow(git, ["add", "-A"]);
      last = check();
      keepCheckChanges(git);
      edits = outcome.files;
      decisions = outcome.decisions;
    }
  }

  const changed = staged();
  if (changed.length > 0) {
    gitOrThrow(git, [
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-q",
      "--no-verify",
      "-m",
      message,
    ]);
  }
  const listed = new Set(edits.map(({ path }) => path));
  const fixes = [
    ...edits.filter(({ path }) => changed.includes(path)),
    ...changed
      .filter((path) => !listed.has(path) && !stagedBefore.has(path))
      .map((path) => ({ path, resolution: FORMATTED, precedent: null })),
  ];
  return last.passed
    ? { passed: true, fixes, decisions }
    : { passed: false, fixes, decisions, remaining: last.output.slice(-MAX_CHECK_OUTPUT) };
}

/** The root `check:all` script with `--continue`, so one failing task does not hide the others. */
function checkAllCommand(workDir: string): string {
  let script: string | undefined;
  try {
    script = (
      JSON.parse(readFileSync(join(workDir, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      }
    ).scripts?.["check:all"];
  } catch {
    // An unparsable package.json is a check failure for the fix agent, not a reason to abort the run.
  }
  return script?.startsWith("pnpm exec turbo run ")
    ? `${script} --continue --output-logs=errors-only`
    : "pnpm run check:all";
}

let checkHome: string | undefined;

/**
 * Formats the tree and runs the repository's quality checks in a container with no credentials, since the tree
 * holds agent edits and the install runs package code. mise provisions the toolchain the tree's own config pins;
 * the tools and ignored output such as `node_modules` stay for the next check in the run.
 */
export function runChecks(workDir: string, image: string): { passed: boolean; output: string } {
  checkHome ??= mkdtempSync(join(tmpdir(), "sync-check-home-"));
  const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  const steps = [
    "pnpm install --frozen-lockfile --ignore-scripts --reporter=silent",
    "(pnpm exec effect-tsgo patch --no-typescript --oxlint >/dev/null 2>&1 || true)",
    "pnpm run --silent fmt:fix >/dev/null",
    checkAllCommand(workDir),
  ].join(" && ");
  console.log("Running the quality checks on the merged tree…");
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      user,
      "--env",
      "HOME=/home/check",
      "--env",
      "CI=true",
      "--env",
      "MISE_YES=1",
      "--env",
      "MISE_TRUSTED_CONFIG_PATHS=/work",
      "--env",
      "MISE_DATA_DIR=/home/check/mise",
      "--env",
      "MISE_CACHE_DIR=/home/check/mise-cache",
      "--volume",
      `${workDir}:/work`,
      "--volume",
      `${join(workDir, ".git")}:/work/.git:ro`,
      "--volume",
      `${checkHome}:/home/check`,
      "--workdir",
      "/work",
      image,
      "sh",
      "-c",
      `mise install --quiet && mise exec -- sh -c '${steps}'`,
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 20 * 60 * 1000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const passed = result.status === 0;
  console.log(passed ? "Checks passed." : `Checks failed (status ${result.status}).`);
  return { passed, output };
}
