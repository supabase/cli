import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const shortTempRoot = () => (process.platform === "win32" ? tmpdir() : "/tmp");

export const defaultCacheRoot = (): string => join(homedir(), ".supabase");

export const DEFAULT_MANAGED_STACK_NAME = "default";

export const defaultManagedProjectsRoot = (cacheRoot: string): string =>
  join(cacheRoot, "projects");

export const projectKeyForProjectDir = (projectDir: string): string =>
  createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 16);

const defaultManagedProjectRoot = (cacheRoot: string, projectDir: string): string =>
  join(defaultManagedProjectsRoot(cacheRoot), projectKeyForProjectDir(projectDir));

export const defaultManagedProjectStacksRoot = (cacheRoot: string, projectDir: string): string =>
  join(defaultManagedProjectRoot(cacheRoot, projectDir), "stacks");

export const defaultManagedStackRoot = (
  cacheRoot: string,
  projectDir: string,
  name: string,
): string => join(defaultManagedProjectStacksRoot(cacheRoot, projectDir), name);

export const displayNameForProjectDir = (projectDir: string): string =>
  basename(resolve(projectDir));

const defaultManagedRuntimeBaseRoot = (): string => join(shortTempRoot(), "supabase");

const runtimeRootId = (stackRoot: string): string =>
  createHash("sha256").update(stackRoot).digest("hex").slice(0, 12);

export const defaultManagedRuntimeRoot = (stackRoot: string): string =>
  join(defaultManagedRuntimeBaseRoot(), `s-${runtimeRootId(stackRoot)}`);

export const socketPathForRuntimeRoot = (runtimeRoot: string): string =>
  join(runtimeRoot, "daemon.sock");

export const shortTempPrefixRoot = (): string => shortTempRoot();
