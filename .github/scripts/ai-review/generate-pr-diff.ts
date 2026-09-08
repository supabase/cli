import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface GeneratePrDiffOptions {
  repositoryPath: string;
  prNumber: number;
  baseRef: string;
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

function validateInputs(prNumber: number, baseRef: string): void {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }
  if (baseRef.length === 0) {
    throw new Error("Base ref must not be empty");
  }
}

export function generatePrDiff(options: GeneratePrDiffOptions): void {
  const repositoryPath = resolve(options.repositoryPath);
  const outputPath = resolve(options.outputPath);
  validateInputs(options.prNumber, options.baseRef);
  runGit(repositoryPath, ["check-ref-format", `refs/heads/${options.baseRef}`]);

  const baseRef = "refs/ai-review/base";
  const headRef = "refs/ai-review/head";
  runGit(repositoryPath, [
    "fetch",
    "--force",
    "--no-tags",
    "origin",
    `+refs/heads/${options.baseRef}:${baseRef}`,
    `+refs/pull/${options.prNumber}/head:${headRef}`,
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
  if (args.length !== 2) {
    throw new Error("Usage: generate-pr-diff.ts <pr-number> <base-ref>");
  }
  return {
    repositoryPath: process.cwd(),
    prNumber: Number(args[0]),
    baseRef: args[1] ?? "",
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
