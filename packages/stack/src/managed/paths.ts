import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertManagedUuid } from "./ids.ts";
import { UnsafeManagedStackPathError, type ManagedStackPaths } from "./model.ts";

export interface ManagedStateRootOptions {
  readonly stateRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.length === 0 ? undefined : value;

export const resolveManagedStateRoot = (options: ManagedStateRootOptions = {}): string => {
  if (options.stateRoot !== undefined) {
    return options.stateRoot;
  }

  const env = options.env ?? process.env;
  const configuredHome = nonEmpty(env["SUPABASE_HOME"]);
  if (configuredHome !== undefined) {
    return join(configuredHome, "managed");
  }

  const platform = options.platform ?? process.platform;
  const userHome = options.homeDir ?? homedir();
  if (platform === "darwin") {
    return join(userHome, "Library", "Application Support", "supabase", "managed");
  }
  if (platform === "win32") {
    const localAppData = nonEmpty(env["LOCALAPPDATA"]);
    return join(localAppData ?? join(userHome, "AppData", "Local"), "Supabase", "managed");
  }

  const stateHome = nonEmpty(env["XDG_STATE_HOME"]);
  return join(stateHome ?? join(userHome, ".local", "state"), "supabase", "managed");
};

export const managedRegistryPath = (stateRoot: string): string =>
  join(stateRoot, "registry-v2.sqlite3");

export const managedStackPaths = (stateRoot: string, stackId: string): ManagedStackPaths => {
  assertManagedUuid(stackId, "stackId");
  const root = join(stateRoot, "stacks", stackId);
  return {
    root,
    data: join(root, "data"),
    logs: join(root, "logs"),
    runtime: join(root, "runtime"),
  };
};

export const assertManagedStackRoot = (
  stateRoot: string,
  stackId: string,
  stackRoot: string,
): string => {
  const expected = resolve(managedStackPaths(stateRoot, stackId).root);
  const actual = resolve(stackRoot);
  if (actual !== expected) {
    throw new UnsafeManagedStackPathError(stackRoot);
  }
  return actual;
};

export const ordinaryWorkspaceIdentityPath = (workspacePath: string): string =>
  join(workspacePath, ".supabase", "identity.json");
