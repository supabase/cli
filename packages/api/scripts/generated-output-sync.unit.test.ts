import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { extractOperations, loadSpec, renderContracts, renderEffectClient } from "./generate.ts";

// Full-fidelity drift guard: re-renders every generated file from the
// committed openapi.json snapshot, formats the result through the same oxfmt
// the pipeline uses, and requires byte equality with the committed files.
// Unlike the operation-level bijection test in src/generated-contract-sync,
// this catches hand edits to schema definitions, parameter lists, request
// bodies, response types, and the executor switch — anything short of
// editing the snapshot and the generated output consistently, which the
// hourly upstream sync then catches.

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(scriptDir, "..");
const generatedDir = path.join(packageDir, "src", "generated");
const oxfmtBin = path.join(packageDir, "node_modules", ".bin", "oxfmt");

function formatWithOxfmt(source: string, fileName: string): string {
  const formatted = execFileSync(oxfmtBin, [`--stdin-filepath=${fileName}`], {
    input: source,
    cwd: packageDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // oxfmt's file mode (what the pipeline runs) trims trailing blank lines to
  // a single newline; its stdin mode preserves them. Normalize so the two
  // modes agree.
  return formatted.replace(/\n+$/, "\n");
}

function committedFile(fileName: string): string {
  return readFileSync(path.join(generatedDir, fileName), "utf8");
}

function expectSameSource(rendered: string, fileName: string): void {
  const committed = committedFile(fileName);
  if (rendered === committed) {
    return;
  }
  const renderedLines = rendered.split("\n");
  const committedLines = committed.split("\n");
  const limit = Math.min(renderedLines.length, committedLines.length);
  let line = 0;
  while (line < limit && renderedLines[line] === committedLines[line]) {
    line += 1;
  }
  expect.fail(
    `src/generated/${fileName} is not what the generator renders from the committed snapshot ` +
      `(first difference at line ${line + 1}):\n` +
      `  committed: ${JSON.stringify(committedLines[line] ?? "<end of file>")}\n` +
      `  rendered:  ${JSON.stringify(renderedLines[line] ?? "<end of file>")}\n` +
      `Hand edits to src/generated are not allowed — run \`pnpm generate\` instead.`,
  );
}

// Rendering contracts.ts runs the real schema codegen for every operation,
// which takes well over vitest's default 5s budget.
const RENDER_TIMEOUT_MS = 120_000;

describe("generated output sync", () => {
  const document = loadSpec();
  const operations = extractOperations(document);

  test(
    "contracts.ts is byte-identical to the generator's render of the committed snapshot",
    { timeout: RENDER_TIMEOUT_MS },
    () => {
      expectSameSource(
        formatWithOxfmt(renderContracts(document, operations), "contracts.ts"),
        "contracts.ts",
      );
    },
  );

  test(
    "effect-client.ts is byte-identical to the generator's render of the committed snapshot",
    { timeout: RENDER_TIMEOUT_MS },
    () => {
      expectSameSource(
        formatWithOxfmt(renderEffectClient(operations), "effect-client.ts"),
        "effect-client.ts",
      );
    },
  );

  test(
    "openapi.json is byte-identical to the generator's normalized rewrite of itself",
    { timeout: RENDER_TIMEOUT_MS },
    () => {
      expectSameSource(
        formatWithOxfmt(`${JSON.stringify(document, null, 2)}\n`, "openapi.json"),
        "openapi.json",
      );
    },
  );
});
