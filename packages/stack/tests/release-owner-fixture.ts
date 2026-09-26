import { runHostProcess } from "../src/internal/host-process.ts";

/** The release this owner reports, which no client build matches. */
export const foreignRelease = "0.0.0-foreign";

if (import.meta.main) await runHostProcess(process.argv.slice(2), { release: foreignRelease });
