import { homedir } from "node:os"; // oxlint-disable-line effecttsgo/node-builtin-import -- plain constant shared by test files.
import { join } from "node:path"; // oxlint-disable-line effecttsgo/node-builtin-import -- plain constant shared by test files.

/** Shared native artifact cache for stack tests; OS temp directories age out files inside published generations. */
export const stackArtifactCacheRoot = join(
  // oxlint-disable-next-line effecttsgo/process-env -- plain constant shared by test files.
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "supabase-stack-artifacts",
);
