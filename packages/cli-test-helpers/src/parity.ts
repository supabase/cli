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

  // Find the separator line: a line that contains only spaces, dashes, and
  // pipes, and has at least one dash.
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

/**
 * Assert Level 2 (structural) parity between two parsed tables.
 * Throws a descriptive Error on mismatch — caught and displayed by vitest.
 */
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
// Parity runner (Level 1)
// ---------------------------------------------------------------------------

export interface ParityOptions {
  apiUrl: string;
  accessToken: string;
  cwd: string;
}

/**
 * Run a CLI command against both the Go and ts-legacy harnesses in parallel,
 * normalize their output, and assert byte-identical (Level 1) parity.
 *
 * On failure throws an Error containing both normalized outputs so the diff is
 * immediately visible in the test report.
 *
 * @example
 * ```ts
 * test.skipIf(process.env["RECORD"] === "true")(
 *   "projects list: ts-legacy stdout matches go",
 *   () => runParity({ apiUrl, accessToken, cwd }, ["projects", "list"]),
 * );
 * ```
 */
export async function runParity(opts: ParityOptions, cmd: string[]): Promise<void> {
  // Create isolated working directories for each CLI so filesystem operations
  // in one run (e.g. `functions new`) don't affect the other.
  const goDir = makeTempDir("cli-e2e-parity-go-");
  const tsDir = makeTempDir("cli-e2e-parity-ts-");
  try {
    const go = await exec(createHarness("go", { ...opts, cwd: goDir.path }), cmd);
    // Reset fixture sequence counters so ts-legacy sees the same API fixture
    // state as Go did — safe for mutating or multi-request commands.
    await fetch(`${opts.apiUrl}/_ctrl/requests`, { method: "DELETE" });
    const ts = await exec(createHarness("ts-legacy", { ...opts, cwd: tsDir.path }), cmd);

    const goNorm = normalize(go.stdout);
    const tsNorm = normalize(ts.stdout);

    if (go.exitCode !== ts.exitCode || goNorm !== tsNorm) {
      const cmdStr = cmd.join(" ");
      const parts: string[] = [
        `Parity failure: ${cmdStr}`,
        `exit codes: go=${go.exitCode.toString()}, ts-legacy=${ts.exitCode.toString()}`,
        "",
        "─── go output ───",
        goNorm.trim() || "(empty)",
        "",
        "─── ts-legacy output ───",
        tsNorm.trim() || "(empty)",
      ];
      if (go.stderr.trim() || ts.stderr.trim()) {
        parts.push(
          "",
          "─── go stderr ───",
          go.stderr.trim() || "(empty)",
          "",
          "─── ts-legacy stderr ───",
          ts.stderr.trim() || "(empty)",
        );
      }
      throw new Error(parts.join("\n"));
    }
  } finally {
    goDir[Symbol.dispose]();
    tsDir[Symbol.dispose]();
  }
}
