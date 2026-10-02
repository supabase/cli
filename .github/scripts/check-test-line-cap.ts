/** A changed `*.test.ts` file may not exceed `max(1000, its non-blank lines at the base commit)`. */

const CAP_FLOOR = 1000;

export interface FileLineCounts {
  readonly path: string;
  readonly baseLines: number;
  readonly headLines: number;
}

export type LineCapViolation = FileLineCounts;

export function findLineCapViolations(
  files: ReadonlyArray<FileLineCounts>,
): ReadonlyArray<LineCapViolation> {
  return files.filter((file) => file.headLines > Math.max(CAP_FLOOR, file.baseLines));
}

export function formatViolation(violation: LineCapViolation): string {
  return `${violation.path}: base ${violation.baseLines} -> head ${violation.headLines} non-blank lines (cap ${Math.max(CAP_FLOOR, violation.baseLines)})`;
}

export function nonBlankLineCount(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly ok: boolean;
}

async function run(argv: ReadonlyArray<string>): Promise<CommandResult> {
  const proc = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, ok: exitCode === 0 };
}

function parseBaseFlag(argv: ReadonlyArray<string>): string | undefined {
  const index = argv.indexOf("--base");
  return index === -1 ? undefined : argv[index + 1];
}

/** Skips the check rather than failing when no base can be resolved, e.g. in a shallow checkout. */
async function resolveBase(explicitBase: string | undefined): Promise<string | undefined> {
  if (explicitBase !== undefined) return explicitBase;

  const envBase = process.env.TEST_LINE_CAP_BASE;
  if (envBase !== undefined && envBase !== "") return envBase;

  const mergeBase = await run(["git", "merge-base", "HEAD", "origin/develop"]);
  if (mergeBase.ok) return mergeBase.stdout.trim();

  console.log(
    "::notice ::could not resolve a merge-base against origin/develop; run `git fetch origin develop` and retry. Skipping the line-cap check for this run.",
  );
  return undefined;
}

interface ChangedFile {
  readonly path: string;
  readonly basePath: string;
}

/**
 * Parses NUL-delimited `git diff --name-status -z` output. A rename or copy record carries a
 * similarity score followed by the old and new paths; a delete carries no new path and is
 * dropped since there is nothing left to check.
 */
export function parseNameStatusZ(output: string): ReadonlyArray<ChangedFile> {
  const fields = output.split("\0");
  const files: ChangedFile[] = [];
  let index = 0;
  while (index < fields.length) {
    const status = fields[index] ?? "";
    if (status === "") {
      index += 1;
      continue;
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const basePath = fields[index + 1] ?? "";
      const path = fields[index + 2] ?? "";
      files.push({ path, basePath });
      index += 3;
      continue;
    }
    if (status.startsWith("D")) {
      index += 2;
      continue;
    }
    const path = fields[index + 1] ?? "";
    files.push({ path, basePath: path });
    index += 2;
  }
  return files;
}

async function changedTestFiles(base: string): Promise<ReadonlyArray<ChangedFile>> {
  const diff = await run(["git", "diff", "--name-status", "-M", "-z", base, "--", "*.test.ts"]);
  if (!diff.ok) {
    throw new Error(`git diff --name-status -M -z ${base} failed: ${diff.stderr.trim()}`);
  }

  const files = [...parseNameStatusZ(diff.stdout)];

  // `git diff` skips untracked files, so a new test file that isn't added yet is listed separately.
  const untracked = await run([
    "git",
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "*.test.ts",
  ]);
  if (!untracked.ok) {
    throw new Error(`git ls-files --others failed: ${untracked.stderr.trim()}`);
  }

  const known = new Set(files.map((file) => file.path));
  for (const path of untracked.stdout.split("\0")) {
    if (path === "" || known.has(path)) continue;
    files.push({ path, basePath: path });
  }

  return files;
}

async function nonBlankLinesAtBase(base: string, path: string): Promise<number> {
  const show = await run(["git", "show", `${base}:${path}`]);
  return show.ok ? nonBlankLineCount(show.stdout) : 0;
}

async function nonBlankLinesInWorkingTree(path: string): Promise<number> {
  return nonBlankLineCount(await Bun.file(path).text());
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const base = await resolveBase(parseBaseFlag(argv));
  if (base === undefined) return;

  const changed = await changedTestFiles(base);
  const files: FileLineCounts[] = [];
  for (const file of changed) {
    const [baseLines, headLines] = await Promise.all([
      nonBlankLinesAtBase(base, file.basePath),
      nonBlankLinesInWorkingTree(file.path),
    ]);
    files.push({ path: file.path, baseLines, headLines });
  }

  const violations = findLineCapViolations(files);
  if (violations.length > 0) {
    for (const violation of violations) console.log(formatViolation(violation));
    console.log("Split the file into a coherent sibling test file; never trim coverage to fit.");
    process.exit(1);
  }

  console.log(`Line-cap ratchet passed for ${files.length} changed test file(s).`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.log(`::error ::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
