import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { validateManagedUuid } from "./ids.ts";
import {
  InvalidManagedIdentityError,
  UnsafeManagedStackPathError,
  type ManagedStackPaths,
} from "./model.ts";

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

const requireManagedStateRoot = (
  stateRoot: string,
): Effect.Effect<string, UnsafeManagedStackPathError> => {
  const trimmed = nonEmpty(stateRoot);
  if (trimmed === undefined) {
    return Effect.fail(
      new UnsafeManagedStackPathError({
        path: stateRoot,
        reason: "Refusing a blank managed state root",
      }),
    );
  }
  return Effect.succeed(resolve(trimmed));
};

/**
 * Every caller- or environment-supplied root is anchored to the working
 * directory once, here. A relative root would otherwise be reinterpreted
 * against whatever the process' cwd happens to be at each later use, so a
 * chdir would split persisted stack state across directories and make
 * {@link assertManagedStackRootEffect} accept a same-shaped path under the new cwd.
 * `homedir()` is absolute by definition and needs no anchoring.
 *
 * An explicit root is a decision, so a blank one is a caller bug and fails
 * rather than falling back: `resolve("")` silently yields the process' working
 * directory, which would scatter managed state across whatever directory a
 * caller happened to start in. Environment values are configuration that may
 * legitimately be present but empty, so a blank one is treated as unset and
 * falls through to the next source.
 */
export const resolveManagedStateRootEffect = (
  options: ManagedStateRootOptions = {},
): Effect.Effect<string, UnsafeManagedStackPathError> => {
  if (options.stateRoot !== undefined) {
    return requireManagedStateRoot(options.stateRoot);
  }

  const env = options.env ?? process.env;
  const configuredHome = nonEmpty(env["SUPABASE_HOME"]);
  if (configuredHome !== undefined) {
    return Effect.succeed(join(resolve(configuredHome), "managed"));
  }

  const platform = options.platform ?? process.platform;
  const userHome = options.homeDir ?? homedir();
  if (platform === "darwin") {
    return Effect.succeed(join(userHome, "Library", "Application Support", "supabase", "managed"));
  }
  if (platform === "win32") {
    const localAppData = nonEmpty(env["LOCALAPPDATA"]);
    return Effect.succeed(
      join(
        localAppData === undefined ? join(userHome, "AppData", "Local") : resolve(localAppData),
        "Supabase",
        "managed",
      ),
    );
  }

  const stateHome = nonEmpty(env["XDG_STATE_HOME"]);
  return Effect.succeed(
    join(
      stateHome === undefined ? join(userHome, ".local", "state") : resolve(stateHome),
      "supabase",
      "managed",
    ),
  );
};

/**
 * The state root a managed stack service must be started with.
 *
 * `stateRoot` is required wherever a service is built, but a caller bypassing
 * the type system (or a plain-JS caller) could still pass `undefined`, which
 * would make {@link resolveManagedStateRootEffect} silently fall back to
 * `SUPABASE_HOME` or the user's home directory instead of failing loudly. A root
 * is a decision the caller owes the service, so a missing one is refused here
 * rather than guessed.
 */
export const requireExplicitManagedStateRootEffect = (
  stateRoot: string | undefined,
): Effect.Effect<string, UnsafeManagedStackPathError> => {
  if (stateRoot === undefined) {
    return Effect.fail(
      new UnsafeManagedStackPathError({
        path: String(stateRoot),
        reason: "Refusing to start a managed stack service without an explicit state root",
      }),
    );
  }
  return resolveManagedStateRootEffect({ stateRoot });
};

export const managedStacksRoot = (stateRoot: string): string => join(stateRoot, "stacks");

const SHA256_STACK_ID_PATTERN = /^[0-9a-f]{64}$/i;

const validateManagedStackId = (
  stackId: string,
): Effect.Effect<string, InvalidManagedIdentityError> => {
  if (SHA256_STACK_ID_PATTERN.test(stackId)) {
    return Effect.succeed(stackId);
  }
  return validateManagedUuid(stackId, "stackId");
};

export const managedStackPathsEffect = (
  stateRoot: string,
  stackId: string,
): Effect.Effect<ManagedStackPaths, InvalidManagedIdentityError> =>
  validateManagedStackId(stackId).pipe(
    Effect.map((id) => {
      const root = join(managedStacksRoot(stateRoot), id);
      return {
        root,
        data: join(root, "data"),
        logs: join(root, "logs"),
        runtime: join(root, "runtime"),
      };
    }),
  );

export const managedStackDocumentPathEffect = (
  stateRoot: string,
  stackId: string,
): Effect.Effect<string, InvalidManagedIdentityError> =>
  Effect.map(managedStackPathsEffect(stateRoot, stackId), ({ root }) => join(root, "stack.json"));

export const assertManagedStackRootEffect = (
  stateRoot: string,
  stackId: string,
  stackRoot: string,
): Effect.Effect<string, InvalidManagedIdentityError | UnsafeManagedStackPathError> =>
  Effect.gen(function* () {
    const expected = resolve((yield* managedStackPathsEffect(stateRoot, stackId)).root);
    const actual = resolve(stackRoot);
    if (actual !== expected) {
      return yield* Effect.fail(new UnsafeManagedStackPathError({ path: stackRoot }));
    }
    return actual;
  });

export const ordinaryWorkspaceIdentityPath = (workspacePath: string): string =>
  join(workspacePath, ".supabase", "identity.json");

/**
 * The config file of the repository a checkout shares with its linked
 * worktrees — the common git directory's own `config`, which is where git keeps
 * repository-local configuration and which `git clone` never copies.
 */
export const gitConfigPath = (commonDirectory: string): string => join(commonDirectory, "config");

/**
 * The worktree-scoped config beside it, which only applies once
 * `extensions.worktreeConfig` is enabled. Git enables that extension by itself —
 * `git sparse-checkout set` does — and moves `core.bare` out of the shared config
 * into this file, so a reader of `core.bare` has to know about it. The one in the
 * common directory belongs to the repository's own worktree, bare or not.
 */
export const gitWorktreeConfigPath = (commonDirectory: string): string =>
  join(commonDirectory, "config.worktree");

/**
 * A checkout's own identity marker, inside its own git directory: the common
 * directory for a primary checkout, `<common>/worktrees/<name>` for a linked
 * one. Git ignores files it does not know about there, so the marker needs no
 * exclusion rule and can never reach the index.
 */
export const gitCheckoutIdentityPath = (gitDirectory: string): string =>
  join(gitDirectory, "supabase-checkout.json");

/** A checkout-scoped detached-context identity beside its checkout marker. */
export const gitDetachedContextIdentityPath = (gitDirectory: string): string =>
  join(gitDirectory, "supabase-detached-context.json");

/** The last canonical workspace path observed for a checkout identity. */
export const gitCheckoutLocationPath = (gitDirectory: string): string =>
  join(gitDirectory, "supabase-checkout-location.json");
