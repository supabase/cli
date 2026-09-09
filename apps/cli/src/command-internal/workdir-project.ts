import { findCliProjectPaths } from "@supabase/config/effect";
import { Data, Effect } from "effect";

import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { sanitizeInlineName } from "./http-errors.ts";

/**
 * `cause.path`/`loaded.path` are anchored under `workdir`; render them
 * relative so a message reads `supabase/config.json` like the rest of the
 * JSON-capable config-load family (`config diff`/`pull`/`push`, `gen types`),
 * regardless of invocation cwd.
 */
export function relativeConfigPath(workdir: string, path: string): string {
  return path.startsWith(workdir) ? path.slice(workdir.length).replace(/^[/\\]/, "") : path;
}

/**
 * The established "no project here" message for a JSON-capable config load
 * (`config diff`/`push`/`pull`, `gen types`, `storage ls|mv|rm|cp`, `seed
 * buckets`) — single source of truth so every one of those commands reports
 * the same text for the same condition.
 *
 * A DEFAULTED workdir keeps today's exact wording (pinned by
 * `diff.e2e.test.ts`/`pull.e2e.test.ts`, both run with no `--workdir`):
 * pointing at `supabase init`, since the ancestor walk-up already searched
 * every directory between here and the filesystem root.
 *
 * An EXPLICIT `--workdir`/`SUPABASE_WORKDIR` never climbed past the named
 * directory (see `workdir-search.ts`), so a bare `supabase init` hint
 * would be misleading — it names the resolved path instead and never
 * suggests `init`, since the fix is to point `--workdir`/`SUPABASE_WORKDIR`
 * at the right directory, not to scaffold a new project there.
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
 * As {@link missingProjectConfigMessage}, but appends a
 * "Did you mean --workdir <ancestor>?" hint when an ancestor directory
 * actually holds a project.
 *
 * Only runs the extra ancestor search when `workdir` was set EXPLICITLY: a
 * DEFAULTED workdir already exhaustively searched every ancestor up to the
 * filesystem root while resolving `workdir` itself (`resolveWorkdir` in
 * `command-settings.layer.ts`), so there is never a "missed" ancestor left
 * to suggest in that case.
 *
 * Purely a message enrichment: `findCliProjectPaths` itself never fails (a
 * failed probe reads as "no config here", not an error — see its own doc
 * comment), so the extra ancestor search can only ever change which sentence
 * comes back, never surface a different error, mask the real failure, or
 * crash the command.
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
 * their own command-specific error type, matching the established pattern
 * for `WorkdirValidationError`.
 */
class WorkdirProjectMissingError extends Data.TaggedError("WorkdirProjectMissingError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * Fails when an EXPLICIT `--workdir`/`SUPABASE_WORKDIR` holds no project —
 * a no-op for a DEFAULTED workdir, which keeps its established tolerant
 * fallback to embedded defaults unchanged (CLI-2285).
 *
 * Only valid for callers that do NOT pass `tomlOnly: true` to their own
 * `loadCliConfig` call: `loadCliConfig` with `tomlOnly: true` can return
 * `null` even when this probe succeeds — a `config.json`-only project, where
 * `findCliProjectPaths` matches it but the TOML-only reader then finds no
 * `config.toml` and returns `null` anyway. Both current callers (`config
 * push`, `seed buckets`) are non-`tomlOnly`, so the probe result and the
 * later `loaded === null` check agree exactly.
 */
export const requireExplicitWorkdirProject = Effect.fnUntraced(function* (cliSettings: {
  readonly workdir: string;
  readonly explicitWorkdir: boolean;
}) {
  if (!cliSettings.explicitWorkdir) {
    return;
  }
  // `explicitWorkdir` is guaranteed `true` past the guard above, so
  // `shouldSearchAncestors` would always evaluate to `false` here —
  // spelled out directly rather than through that predicate.
  const paths = yield* findCliProjectPaths(cliSettings.workdir, { search: false });
  if (paths === null) {
    return yield* new WorkdirProjectMissingError({
      message: yield* missingProjectConfigMessageEffect(cliSettings),
    });
  }
});
