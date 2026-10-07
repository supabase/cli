import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface GenerateNextContextOptions {
  repositoryPath: string;
  baseRef: string;
  outputPath: string;
}

const MAX_COMMIT_LINES = 200;
const MAX_STAT_LINES = 100;
const MAX_SUBJECT_LENGTH = 120;
const BREAKING_TITLE = /^- [a-z]+(\([^)]*\))?!:/;

function git(repositoryPath: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, { cwd: repositoryPath, encoding: "utf8" });
  return { ok: result.status === 0, stdout: result.stdout ?? "" };
}

function capped(lines: string[], max: number): string[] {
  return lines.length <= max ? lines : [...lines.slice(0, max), `… ${lines.length - max} more`];
}

function sanitizeSubject(line: string): string {
  const subject = line.replaceAll("`", "'");
  return subject.length <= MAX_SUBJECT_LENGTH
    ? subject
    : `${subject.slice(0, MAX_SUBJECT_LENGTH)}…`;
}

/**
 * Writes the `next` branch's pending work to `outputPath` when a PR targets `develop` and `next`
 * exists; returns whether a file was written. Needs `refs/ai-review/base` from `generate-pr-diff`.
 */
export function generateNextContext(options: GenerateNextContextOptions): boolean {
  const repositoryPath = resolve(options.repositoryPath);
  const outputPath = resolve(options.outputPath);
  rmSync(outputPath, { force: true });

  if (options.baseRef !== "develop") return false;
  if (!git(repositoryPath, ["ls-remote", "--exit-code", "--heads", "origin", "next"]).ok) {
    return false;
  }
  const fetched = git(repositoryPath, [
    "fetch",
    "--force",
    "--no-tags",
    "origin",
    "+refs/heads/next:refs/ai-review/next",
  ]);
  if (!fetched.ok) return false;

  const commits = git(repositoryPath, [
    "log",
    "--no-merges",
    "--format=- %s",
    "refs/ai-review/base..refs/ai-review/next",
  ]);
  const stat = git(repositoryPath, ["diff", "--stat", "refs/ai-review/base...refs/ai-review/next"]);
  if (!commits.ok || !stat.ok) return false;

  const commitLines = commits.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map(sanitizeSubject);
  if (commitLines.length === 0) return false;
  const ordered = [
    ...commitLines.filter((line) => BREAKING_TITLE.test(line)),
    ...commitLines.filter((line) => !BREAKING_TITLE.test(line)),
  ];
  const statLines = stat.stdout.split("\n").filter((line) => line.length > 0);

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    [
      "# Work on the `next` branch",
      "",
      "Commits on `next` that are not on `develop` (breaking `!` titles first):",
      "",
      "```",
      ...capped(ordered, MAX_COMMIT_LINES),
      "```",
      "",
      "Files changed on `next` since it diverged from `develop`:",
      "",
      "```",
      ...capped(statLines, MAX_STAT_LINES),
      "```",
      "",
    ].join("\n"),
  );
  return true;
}

if (import.meta.main) {
  const baseRef = process.argv[2] ?? "";
  try {
    generateNextContext({
      repositoryPath: process.cwd(),
      baseRef,
      outputPath: "/tmp/ai-review/next-context.md",
    });
  } catch (error) {
    // Advisory input: a failure here must never fail the review.
    console.warn(`Skipping next-branch context: ${String(error)}`);
  }
}
