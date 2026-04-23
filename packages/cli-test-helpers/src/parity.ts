import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, exec, makeTempDir } from "./harness.ts";
import { normalize } from "./normalize.ts";

// ---------------------------------------------------------------------------
// Table parsing (Level 2)
// ---------------------------------------------------------------------------

export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

/**
 * Parse the Go CLI pipe-separated table format into structured headers and rows.
 *
 * Expected format:
 * ```
 *    COLUMN1 | COLUMN2 | COLUMN3
 *   ---------|---------|--------
 *    val1    | val2    | val3
 * ```
 *
 * Returns `{ headers: [], rows: [] }` when the output contains no table
 * (e.g. commands that return an empty list with no separator line).
 */
export function parseTable(output: string): ParsedTable {
  const lines = output.split("\n");

  let separatorIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && /^[\s\-|]+$/.test(line) && line.includes("-")) {
      separatorIdx = i;
      break;
    }
  }

  if (separatorIdx <= 0) {
    return { headers: [], rows: [] };
  }

  const headerLine = lines[separatorIdx - 1];
  if (!headerLine?.trim()) {
    return { headers: [], rows: [] };
  }

  const parseLine = (line: string): string[] => line.split("|").map((cell) => cell.trim());

  const headers = parseLine(headerLine);
  const rows = lines
    .slice(separatorIdx + 1)
    .filter((line) => line.trim() !== "")
    .map(parseLine);

  return { headers, rows };
}

/** Assert structural parity between two parsed tables. Throws on mismatch. */
export function assertTableParity(go: ParsedTable, ts: ParsedTable, context = ""): void {
  const ctx = context ? ` [${context}]` : "";

  if (JSON.stringify(ts.headers) !== JSON.stringify(go.headers)) {
    throw new Error(
      `Table header mismatch${ctx}:\n  go:        [${go.headers.join(", ")}]\n  ts-legacy: [${ts.headers.join(", ")}]`,
    );
  }

  if (ts.rows.length !== go.rows.length) {
    throw new Error(
      `Table row count mismatch${ctx}: go=${go.rows.length.toString()}, ts-legacy=${ts.rows.length.toString()}`,
    );
  }

  for (let i = 0; i < go.rows.length; i++) {
    if (JSON.stringify(ts.rows[i]) !== JSON.stringify(go.rows[i])) {
      throw new Error(
        `Table row ${i.toString()} mismatch${ctx}:\n  go:        [${go.rows[i]?.join(", ")}]\n  ts-legacy: [${ts.rows[i]?.join(", ")}]`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// RunResult types
// ---------------------------------------------------------------------------

export interface RequestRecord {
  method: string;
  pathname: string;
  query: Record<string, string>;
  body: unknown;
}

export interface FileRecord {
  /** Path relative to the command's working directory. */
  path: string;
  /** SHA-256 of normalize(content), or "deleted" for removed files. */
  hash: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** API calls made during the command, in order. */
  requests: RequestRecord[];
  /** Files created/modified/deleted in the working directory. */
  files: FileRecord[];
}

// ---------------------------------------------------------------------------
// Git-based file snapshot
// ---------------------------------------------------------------------------

const GIT_ENV: Record<string, string> = {
  ...(process.env as Record<string, string>),
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function initGitRepo(dir: string): void {
  Bun.spawnSync(["git", "init"], { cwd: dir, env: GIT_ENV, stdout: "pipe", stderr: "pipe" });
  Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], {
    cwd: dir,
    env: GIT_ENV,
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Snapshot files changed since the initial commit using git status.
 *  Only files that the CLI command actually created, modified, or deleted
 *  appear in the result — pre-existing files are not included. */
function snapshotChangedFiles(dir: string): FileRecord[] {
  const proc = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=all"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new TextDecoder().decode(proc.stdout).trim();
  if (!output) return [];

  const records: FileRecord[] = [];

  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    // git status --porcelain format: "XY filename" where XY is a 2-char status code.
    const xy = line.slice(0, 2);
    const filePath = line.slice(3).trim();

    if (xy[0] === "D" || xy[1] === "D") {
      records.push({ path: filePath, hash: "deleted" });
      continue;
    }

    const fullPath = join(dir, filePath);
    try {
      const content = readFileSync(fullPath, "utf8");
      const hash = createHash("sha256").update(normalize(content)).digest("hex");
      records.push({ path: filePath, hash });
    } catch {
      // Binary or unreadable as text — hash raw bytes without normalization.
      const raw = readFileSync(fullPath);
      const hash = createHash("sha256").update(raw).digest("hex");
      records.push({ path: filePath, hash });
    }
  }

  return records.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// RunResult collection
// ---------------------------------------------------------------------------

async function fetchRequestLog(apiUrl: string): Promise<RequestRecord[]> {
  const res = await fetch(`${apiUrl}/_ctrl/requests`);
  const raw = (await res.json()) as Array<{
    method: string;
    pathname: string;
    query: Record<string, string>;
    body: unknown;
  }>;
  return raw.map(({ method, pathname, query, body }) => ({ method, pathname, query, body }));
}

async function collectRunResult(
  harness: ReturnType<typeof createHarness>,
  cmd: string[],
  dir: string,
  apiUrl: string,
): Promise<RunResult> {
  const result = await exec(harness, cmd);
  const requests = await fetchRequestLog(apiUrl);
  const files = snapshotChangedFiles(dir);
  return {
    stdout: normalize(result.stdout),
    stderr: normalize(result.stderr),
    exitCode: result.exitCode,
    requests,
    files,
  };
}

// ---------------------------------------------------------------------------
// Comparison and diff output
// ---------------------------------------------------------------------------

function formatSection(label: string, go: string, ts: string): string {
  return [
    `─── ${label}: go ───`,
    go.trim() || "(empty)",
    "",
    `─── ${label}: ts-legacy ───`,
    ts.trim() || "(empty)",
  ].join("\n");
}

function compareRunResults(cmdStr: string, go: RunResult, ts: RunResult): void {
  const summary: string[] = [];
  const diffs: string[] = [];

  if (go.exitCode !== ts.exitCode) {
    summary.push(
      `  ✗ exit code: go=${go.exitCode.toString()}, ts-legacy=${ts.exitCode.toString()}`,
    );
  } else {
    summary.push(`  ✓ exit code: ${go.exitCode.toString()}`);
  }

  if (go.stdout !== ts.stdout) {
    summary.push("  ✗ stdout differs");
    diffs.push(formatSection("stdout", go.stdout, ts.stdout));
  } else {
    summary.push("  ✓ stdout matches");
  }

  if (go.stderr !== ts.stderr) {
    summary.push("  ✗ stderr differs");
    diffs.push(formatSection("stderr", go.stderr, ts.stderr));
  } else {
    summary.push("  ✓ stderr matches");
  }

  const goReqs = JSON.stringify(go.requests, null, 2);
  const tsReqs = JSON.stringify(ts.requests, null, 2);
  if (goReqs !== tsReqs) {
    summary.push("  ✗ request log differs");
    diffs.push(formatSection("request log", goReqs, tsReqs));
  } else {
    summary.push("  ✓ request log matches");
  }

  const goFiles = JSON.stringify(go.files, null, 2);
  const tsFiles = JSON.stringify(ts.files, null, 2);
  if (goFiles !== tsFiles) {
    summary.push("  ✗ filesystem differs");
    diffs.push(formatSection("filesystem", goFiles, tsFiles));
  } else if (go.files.length === 0) {
    summary.push("  ✓ filesystem: no side-effects");
  } else {
    summary.push("  ✓ filesystem matches");
  }

  if (summary.some((line) => line.includes("✗"))) {
    throw new Error([`Parity failure: ${cmdStr}`, "", ...summary, "", ...diffs].join("\n"));
  }
}

// ---------------------------------------------------------------------------
// Parity runner
// ---------------------------------------------------------------------------

export interface ParityOptions {
  apiUrl: string;
  accessToken: string;
  /** @deprecated cwd is unused — runParity creates isolated temp dirs internally */
  cwd?: string;
  /** Set as SUPABASE_PROJECT_ID in both harnesses (e.g. for storage --local mode). */
  projectId?: string;
  /** Called on each temp dir before running the CLI — use to write config files. */
  workspaceSetup?: (dir: string) => void;
}

/**
 * Run a CLI command against both the Go and ts-legacy harnesses, compare all
 * observable dimensions (stdout, stderr, exit code, API request log, filesystem
 * side-effects), and throw a per-dimension diff on any mismatch.
 *
 * Self-cleaning: resets the replay server request log both between runs and
 * after the ts-legacy run, so callers don't need to clean up.
 */
export async function runParity(opts: ParityOptions, cmd: string[]): Promise<void> {
  const goDir = makeTempDir("cli-e2e-parity-go-");
  const tsDir = makeTempDir("cli-e2e-parity-ts-");
  try {
    initGitRepo(goDir.path);
    initGitRepo(tsDir.path);

    opts.workspaceSetup?.(goDir.path);
    const goResult = await collectRunResult(
      createHarness("go", {
        apiUrl: opts.apiUrl,
        accessToken: opts.accessToken,
        cwd: goDir.path,
        projectId: opts.projectId,
      }),
      cmd,
      goDir.path,
      opts.apiUrl,
    );

    await fetch(`${opts.apiUrl}/_ctrl/requests`, { method: "DELETE" });

    opts.workspaceSetup?.(tsDir.path);
    const tsResult = await collectRunResult(
      createHarness("ts-legacy", {
        apiUrl: opts.apiUrl,
        accessToken: opts.accessToken,
        cwd: tsDir.path,
        projectId: opts.projectId,
      }),
      cmd,
      tsDir.path,
      opts.apiUrl,
    );

    // Self-cleaning: reset after ts-legacy so callers start with a clean log.
    await fetch(`${opts.apiUrl}/_ctrl/requests`, { method: "DELETE" });

    compareRunResults(cmd.join(" "), goResult, tsResult);
  } finally {
    goDir[Symbol.dispose]();
    tsDir[Symbol.dispose]();
  }
}
