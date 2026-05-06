export type { CLIHarness, CLIResult, CLITarget, HarnessOptions, TempDir } from "./harness.ts";
export { createHarness, exec, makeTempDir } from "./harness.ts";
export { normalize, sortTableRows } from "./normalize.ts";
export type { FileRecord, ParsedTable, ParityOptions, RequestRecord, RunResult } from "./parity.ts";
export { assertTableParity, parseTable, runParity } from "./parity.ts";
