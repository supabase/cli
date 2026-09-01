import { homedir, tmpdir } from "node:os";
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Exported path helpers are synchronous platform boundary values used before Effect runtime setup.
import { join } from "node:path";

const shortTempRoot = () => (process.platform === "win32" ? tmpdir() : "/tmp");

export const defaultCacheRoot = (): string => join(homedir(), ".supabase");

export const DEFAULT_MANAGED_STACK_NAME = "default";

export const shortTempPrefixRoot = (): string => shortTempRoot();
