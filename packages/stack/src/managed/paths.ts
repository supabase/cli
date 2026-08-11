import { homedir } from "node:os";
import { join } from "node:path";
import type { ManagedStackPaths } from "./model.ts";

export interface ManagedStateRootOptions {
  readonly stateRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
}

export const resolveManagedStateRoot = (options: ManagedStateRootOptions = {}): string => {
  if (options.stateRoot !== undefined) {
    return options.stateRoot;
  }

  const env = options.env ?? process.env;
  const configuredHome = env["SUPABASE_HOME"];
  if (configuredHome !== undefined && configuredHome.length > 0) {
    return join(configuredHome, "managed");
  }

  const platform = options.platform ?? process.platform;
  const userHome = options.homeDir ?? homedir();
  if (platform === "darwin") {
    return join(userHome, "Library", "Application Support", "supabase", "managed");
  }
  if (platform === "win32") {
    const localAppData = env["LOCALAPPDATA"];
    return join(localAppData ?? join(userHome, "AppData", "Local"), "Supabase", "managed");
  }

  const stateHome = env["XDG_STATE_HOME"];
  return join(stateHome ?? join(userHome, ".local", "state"), "supabase", "managed");
};

export const managedRegistryPath = (stateRoot: string): string =>
  join(stateRoot, "registry-v1.sqlite3");

export const managedStackPaths = (stateRoot: string, stackId: string): ManagedStackPaths => {
  const root = join(stateRoot, "stacks", stackId);
  return {
    root,
    data: join(root, "data"),
    logs: join(root, "logs"),
    runtime: join(root, "runtime"),
  };
};

export const ordinaryWorkspaceIdentityPath = (workspacePath: string): string =>
  join(workspacePath, ".supabase", "identity.json");
