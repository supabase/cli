export type { CLIHarness, CLIResult, CLITarget, HarnessOptions, TempDir } from "./harness.ts";
export { createHarness, exec, makeTempDir } from "./harness.ts";
export { normalize } from "./normalize.ts";
export type { ParsedTable, ParityOptions } from "./parity.ts";
export { assertTableParity, parseTable, runParity } from "./parity.ts";
