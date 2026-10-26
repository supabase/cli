import { Crypto, Effect, Path } from "effect";

import { CommandSettings } from "../config/command-settings.service.ts";
import { legacyProjectStatePaths } from "../shared/config/legacy-project-state.paths.ts";
import { usesStackState } from "./stack-backend.ts";

/** Host scratch for bundler output and downloads: `$SUPABASE_HOME/tmp` in stack state, else `supabase/.temp`. */
export const scratchDir = Effect.fnUntraced(function* (projectRoot: string) {
  const path = yield* Path.Path;
  if (yield* usesStackState) return path.join((yield* CommandSettings).supabaseHome, "tmp");
  return legacyProjectStatePaths(path, projectRoot).tempDir;
});

/**
 * Catalog snapshots and debug bundles of the pg-delta engines, under {@link scratchDir}. The
 * stack-state scratch is shared by every project, so it gains a per-project directory.
 */
export const pgdeltaScratchDir = Effect.fnUntraced(function* (projectRoot: string) {
  const path = yield* Path.Path;
  const root = path.join(yield* scratchDir(projectRoot), "pgdelta");
  if (!(yield* usesStackState)) return root;
  const digest = yield* (yield* Crypto.Crypto).digest(
    "SHA-256",
    new TextEncoder().encode(path.resolve(projectRoot)),
  );
  return path.join(
    root,
    Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join(""),
  );
});
