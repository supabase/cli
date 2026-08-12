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

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

/**
 * Every caller- or environment-supplied root is anchored to the working
 * directory once, here. A relative root would otherwise be reinterpreted
 * against whatever the process' cwd happens to be at each later use, so a
 * chdir would split persisted stack state across directories and make
 * {@link assertManagedStackRoot} accept a same-shaped path under the new cwd.
 * `homedir()` is absolute by definition and needs no anchoring.
 */
export const resolveManagedStateRoot = (options: ManagedStateRootOptions = {}): string => {
  if (options.stateRoot !== undefined) {
    return resolve(options.stateRoot);
  }

  const env = options.env ?? process.env;
  const configuredHome = nonEmpty(env["SUPABASE_HOME"]);
  if (configuredHome !== undefined) {
    return join(resolve(configuredHome), "managed");
  }

  const platform = options.platform ?? process.platform;
  const userHome = options.homeDir ?? homedir();
  if (platform === "darwin") {
    return join(userHome, "Library", "Application Support", "supabase", "managed");
  }
  if (platform === "win32") {
    const localAppData = nonEmpty(env["LOCALAPPDATA"]);
    return join(
      localAppData === undefined ? join(userHome, "AppData", "Local") : resolve(localAppData),
      "Supabase",
      "managed",
    );
  }

  const stateHome = nonEmpty(env["XDG_STATE_HOME"]);
  return join(
    stateHome === undefined ? join(userHome, ".local", "state") : resolve(stateHome),
    "supabase",
    "managed",
  );
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
