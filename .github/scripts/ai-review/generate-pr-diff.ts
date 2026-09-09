import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface GeneratePrDiffOptions {
  repositoryPath: string;
  prNumber: number;
  baseRef: string;
  /** Immutable commit to diff; never a moving pull-request head ref. */
  headSha: string;
  outputPath: string;
}

function runGit(repositoryPath: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd: repositoryPath,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  }
}

function validateInputs(prNumber: number, baseRef: string, headSha: string): void {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }
  if (baseRef.length === 0) {
    throw new Error("Base ref must not be empty");
  }
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    throw new Error(`Invalid head SHA: ${headSha}`);
  }
}

export function generatePrDiff(options: GeneratePrDiffOptions): void {
  const repositoryPath = resolve(options.repositoryPath);
  const outputPath = resolve(options.outputPath);
  validateInputs(options.prNumber, options.baseRef, options.headSha);
  runGit(repositoryPath, ["check-ref-format", `refs/heads/${options.baseRef}`]);

  const baseRef = "refs/ai-review/base";
  const headRef = "refs/ai-review/head";
  runGit(repositoryPath, [
    "fetch",
    "--force",
    "--no-tags",
    "origin",
    `+refs/heads/${options.baseRef}:${baseRef}`,
    `+${options.headSha}:${headRef}`,
  ]);

  mkdirSync(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const output = openSync(temporaryPath, "wx");
  try {
    try {
      const result = spawnSync(
        "git",
        ["diff", "--no-ext-diff", "--no-textconv", `${baseRef}...${headRef}`, "--"],
        {
          cwd: repositoryPath,
          stdio: ["ignore", output, "pipe"],
          encoding: "utf8",
        },
      );
      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        throw new Error(`git diff failed: ${result.stderr.trim()}`);
      }
    } finally {
      closeSync(output);
    }
    renameSync(temporaryPath, outputPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function parseArguments(args: string[]): GeneratePrDiffOptions {
  if (args.length !== 3) {
    throw new Error("Usage: generate-pr-diff.ts <pr-number> <base-ref> <head-sha>");
  }
  return {
    repositoryPath: process.cwd(),
    prNumber: Number(args[0]),
    baseRef: args[1] ?? "",
    headSha: args[2] ?? "",
    outputPath: "/tmp/ai-review/pr.diff",
  };
}

if (import.meta.main) {
  try {
    generatePrDiff(parseArguments(process.argv.slice(2)));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
