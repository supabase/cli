import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const shortTempRoot = () => (process.platform === "win32" ? tmpdir() : "/tmp");

export const defaultCacheRoot = (): string => join(homedir(), ".supabase");

export const defaultManagedStacksRoot = (cacheRoot: string): string => join(cacheRoot, "stacks");

export const defaultManagedStackRoot = (cacheRoot: string, name: string): string =>
  join(defaultManagedStacksRoot(cacheRoot), name);

const defaultManagedRuntimeBaseRoot = (): string => join(shortTempRoot(), "supabase");

const runtimeRootId = (stackRoot: string): string =>
  createHash("sha256").update(stackRoot).digest("hex").slice(0, 12);

export const defaultManagedRuntimeRoot = (stackRoot: string): string =>
  join(defaultManagedRuntimeBaseRoot(), `s-${runtimeRootId(stackRoot)}`);

export const socketPathForRuntimeRoot = (runtimeRoot: string): string =>
  join(runtimeRoot, "daemon.sock");

export const shortTempPrefixRoot = (): string => shortTempRoot();
