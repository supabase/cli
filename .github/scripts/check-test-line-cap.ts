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
  return `${violation.path}: base ${violation.baseLines} -> head ${violation.headLines} non-blank lines (cap ${CAP_FLOOR})`;
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
    "::notice ::origin/develop not found locally; fetching it before resolving a merge-base.",
  );
  await run(["git", "fetch", "--no-tags", "--depth=50", "origin", "develop"]);
  const retried = await run(["git", "merge-base", "HEAD", "origin/develop"]);
  if (retried.ok) return retried.stdout.trim();

  console.log(
    "::notice ::could not resolve a merge-base against origin/develop; skipping the line-cap check for this run.",
  );
  return undefined;
}

interface ChangedFile {
  readonly path: string;
  readonly basePath: string;
}

async function changedTestFiles(base: string): Promise<ReadonlyArray<ChangedFile>> {
  const diff = await run(["git", "diff", "--name-status", "-M", base, "--", "*.test.ts"]);
  if (!diff.ok) {
    throw new Error(`git diff --name-status -M ${base} failed: ${diff.stderr.trim()}`);
  }

  const files: ChangedFile[] = [];
  for (const line of diff.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [status = "", first = "", second] = line.split("\t");
    if (status.startsWith("D")) continue;
    if (status.startsWith("R")) {
      files.push({ path: second ?? "", basePath: first });
      continue;
    }
    files.push({ path: first, basePath: first });
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
