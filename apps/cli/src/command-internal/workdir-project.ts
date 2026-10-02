import { findCliProjectPaths } from "@supabase/config/effect";
import { Data, Effect } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { sanitizeInlineName } from "./http-errors.ts";

/** Renders a config-load path relative to `workdir` (e.g. `supabase/config.json`), regardless of invocation cwd. */
export function relativeConfigPath(workdir: string, path: string): string {
  return path.startsWith(workdir) ? path.slice(workdir.length).replace(/^[/\\]/, "") : path;
}

/**
 * Shared "no project here" message for JSON-capable config loads (`config diff/push/pull`,
 * `gen types`, `storage ls|mv|rm|cp`, `seed buckets`).
 *
 * A defaulted workdir suggests `supabase init`, since the ancestor walk-up already searched up to
 * the filesystem root. An explicit `--workdir`/`SUPABASE_WORKDIR` never climbs, so it names the
 * resolved path instead of suggesting `init`.
 */
export function missingProjectConfigMessage(input: {
  readonly workdir: string;
  readonly explicitWorkdir: boolean;
}): string {
  if (!input.explicitWorkdir) {
    return "failed to read supabase/config.toml or supabase/config.json: file not found. Run `supabase init` to create one.";
  }
  return `failed to read supabase/config.toml or supabase/config.json in ${sanitizeInlineName(input.workdir)}: file not found. --workdir/SUPABASE_WORKDIR is used exactly as given and no ancestor directory is searched, so it must name the directory that contains your supabase/ folder.`;
}

/**
 * As {@link missingProjectConfigMessage}, but appends a "Did you mean --workdir <ancestor>?" hint
 * when an ancestor directory holds a project.
 *
 * Only searches ancestors for an explicit workdir; a defaulted workdir already searched them all
 * while resolving itself.
 */
export const missingProjectConfigMessageEffect = Effect.fnUntraced(function* (cliSettings: {
  readonly workdir: string;
  readonly explicitWorkdir: boolean;
}) {
  const base = missingProjectConfigMessage(cliSettings);
  if (!cliSettings.explicitWorkdir) {
    return base;
  }
  const ancestor = yield* findCliProjectPaths(cliSettings.workdir, { search: true });
  return ancestor === null
    ? base
    : `${base} Did you mean --workdir ${sanitizeInlineName(ancestor.projectRoot)}?`;
});

/**
 * Raised by {@link requireExplicitWorkdirProject} when an explicit
 * `--workdir`/`SUPABASE_WORKDIR` names a directory with no
 * `supabase/config.toml`/`config.json` of its own. Callers map this into
 * their own command-specific error type.
 */
class WorkdirProjectMissingError extends Data.TaggedError("WorkdirProjectMissingError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Fails when an explicit `--workdir`/`SUPABASE_WORKDIR` holds no project; a no-op for a defaulted
 * workdir.
 *
 * Only valid for callers that don't pass `tomlOnly: true` to `loadCliConfig` — that mode can
 * return `null` for a `config.json`-only project even though this probe succeeds.
 */
export const requireExplicitWorkdirProject = Effect.fnUntraced(function* (cliSettings: {
  readonly workdir: string;
  readonly explicitWorkdir: boolean;
}) {
  if (!cliSettings.explicitWorkdir) {
    return;
  }
  const paths = yield* findCliProjectPaths(cliSettings.workdir, { search: false });
  if (paths === null) {
    return yield* new WorkdirProjectMissingError({
      message: yield* missingProjectConfigMessageEffect(cliSettings),
    });
  }
});
