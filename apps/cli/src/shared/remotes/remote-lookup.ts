import { findProjectPaths, listRemotes } from "@supabase/config";
import { Effect } from "effect";
import { NoProjectConfigError, UnknownRemoteError } from "./remotes.errors.ts";

/**
 * Resolves a `--remote`/`SUPABASE_REMOTE` NAME to its `project_id`, the one
 * `RemoteRegistry` read path both shells share. Pure config read, no network.
 */
export const resolveRemoteRef = Effect.fnUntraced(function* (cwd: string, name: string) {
  const remotes = yield* listRemotes(cwd);
  if (remotes === null) {
    return yield* Effect.fail(
      new NoProjectConfigError({
        message: "No supabase/config.toml or supabase/config.json found.",
      }),
    );
  }
  const match = remotes.find((remote) => remote.name === name);
  if (match === undefined) {
    const project = yield* findProjectPaths(cwd);
    return yield* Effect.fail(
      new UnknownRemoteError({
        name,
        registryPath: project?.configPath ?? "supabase/config.toml",
        empty: remotes.length === 0,
      }),
    );
  }
  return match.projectRef;
});
