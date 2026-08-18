import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { Effect } from "effect";
import { InvalidWorkerSourceError, InvalidWorkersRootError } from "./workers.errors.ts";

/**
 * The project layout every worker command resolves against:
 *
 *   supabase/
 *     config.toml          project config — workers record `[workers.<name>]` here
 *     workers/<name>/      one directory per worker; the name IS the directory
 *
 * This mirrors `supabase/functions/<slug>/` on purpose: `supabase workers` is a
 * sibling of `supabase functions`, not a separate tool with its own
 * conventions. A worker's name and its directory are the same fact, so
 * `push`/`status`/`delete <name>` needs no separate lookup, and running from
 * inside the directory needs no name at all.
 *
 * `workers/` is the default, not a rule. Two keys move it, at two scopes:
 * `[workers] root` moves the directory workers are grouped in (project-wide,
 * relative to `supabase/`), and `[workers.<name>] source` moves one worker's
 * code anywhere in the repo (relative to the project root). `source` wins
 * wherever it is set.
 *
 * The root is validated once per command, by {@link resolveWorkersRoot}; every
 * helper below takes the validated value, so a bad `[workers] root` fails in
 * one place rather than at whichever path happens to be joined first.
 */

/** Where workers live under `supabase/` unless `[workers] root` says otherwise. */
const DEFAULT_WORKERS_ROOT = "workers";

/**
 * Directories under `supabase/` the CLI already owns. Pointing `[workers] root`
 * at one would make every Edge Function (or migration) look like a worker to
 * `supabase workers list`, so it is refused rather than warned about.
 */
const RESERVED_ROOT_DIRS = ["functions", "migrations"];

const rootSuggestion =
  'Set `[workers] root` to a directory name inside supabase/, for example root = "services", ' +
  "or move a single worker with `[workers.<name>] source`.";

/**
 * `[workers] root`, validated. Confined to `supabase/`: absolute paths, any
 * `..` that would climb out, and `supabase/` itself are refused, as are the
 * directories the CLI already owns. The per-worker `source` key is the one that
 * can leave.
 */
export function resolveWorkersRoot(
  configured: string | undefined,
): Effect.Effect<string, InvalidWorkersRootError> {
  if (configured === undefined) {
    return Effect.succeed(DEFAULT_WORKERS_ROOT);
  }

  const refuse = (why: string) =>
    Effect.fail(
      new InvalidWorkersRootError({
        detail: `[workers] root "${configured}" ${why}.`,
        suggestion: rootSuggestion,
      }),
    );

  // A trailing slash is how anyone would naturally write a directory.
  const trimmed = configured.trim().replace(/[/\\]+$/, "");
  if (trimmed === "" || trimmed === ".") {
    return refuse("would make supabase/ itself the workers directory");
  }
  if (isAbsolute(trimmed)) {
    return refuse("is an absolute path");
  }

  const normalized = normalize(trimmed);
  if (normalized.startsWith("..")) {
    return refuse("climbs outside supabase/");
  }
  const first = normalized.split(/[/\\]/)[0] ?? "";
  if (RESERVED_ROOT_DIRS.includes(first)) {
    return refuse(
      `is a directory the Supabase CLI already owns — everything in supabase/${first}/ would be listed as a worker`,
    );
  }

  return Effect.succeed(normalized);
}

/** `supabase/<root>/` — the validated root resolved against the project. */
export function workersRootDir(projectRoot: string, root: string): string {
  return join(projectRoot, "supabase", root);
}

/** Whether `candidate` is `parent` itself or sits underneath it. */
function isAtOrUnder(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * `--source`, resolved against the directory the user typed it in and validated
 * before anything is written.
 *
 * This one is load-bearing for safety, not just tidiness: the resolved path is
 * the directory `--force` deletes outright, so a value naming the project root,
 * `supabase/`, or anywhere outside the project would destroy work that has
 * nothing to do with the worker. `source` is the key that is *allowed* to leave
 * the workers directory, but not the project.
 *
 * `functions/` and `migrations/` are refused for the same reason `[workers] root`
 * refuses them: they belong to other parts of the CLI.
 */
export function resolveWorkerSource(options: {
  readonly projectRoot: string;
  readonly cwd: string;
  readonly raw: string;
}): Effect.Effect<string, InvalidWorkerSourceError> {
  const refuse = (why: string) =>
    Effect.fail(
      new InvalidWorkerSourceError({
        detail: `--source "${options.raw}" ${why}.`,
        suggestion:
          "Point --source at a directory inside the project, for example --source packages/api.",
      }),
    );

  const trimmed = options.raw.trim().replace(/[/\\]+$/, "");
  if (trimmed === "") {
    return refuse("is empty");
  }

  const destination = resolve(options.cwd, trimmed);
  const projectRoot = resolve(options.projectRoot);
  const supabaseDir = join(projectRoot, "supabase");

  if (destination === projectRoot) {
    return refuse("is the project root itself");
  }
  if (!isAtOrUnder(projectRoot, destination)) {
    return refuse("is outside the project");
  }
  if (destination === supabaseDir) {
    return refuse("is the supabase directory itself");
  }
  for (const reserved of RESERVED_ROOT_DIRS) {
    if (isAtOrUnder(join(supabaseDir, reserved), destination)) {
      return refuse(`is inside supabase/${reserved}/, which the Supabase CLI already owns`);
    }
  }

  return Effect.succeed(destination);
}

/** A worker's default directory: `supabase/<root>/<name>/`. */
export function workerDir(projectRoot: string, root: string, name: string): string {
  return join(workersRootDir(projectRoot, root), name);
}

/**
 * A worker's source directory: `[workers.<name>] source` when one is recorded,
 * resolved against the project root, otherwise the default directory.
 */
export function workerSourceDir(
  projectRoot: string,
  defaultDir: string,
  configuredSource: string | undefined,
): string {
  return configuredSource === undefined || configuredSource === ""
    ? defaultDir
    : resolve(projectRoot, configuredSource);
}

/**
 * The worker `cwd` is inside, when it is directly inside one — the directory is
 * the mapping, so there is nothing to look up. Compares resolved paths rather
 * than directory names: with `[workers] root` in play there is no fixed name to
 * match on, and an exact comparison never fires on some unrelated `workers/api/`
 * elsewhere in the tree.
 */
export function inferWorkerNameFromCwd(cwd: string, rootDir: string): string | undefined {
  const rel = relative(resolve(rootDir), resolve(cwd));
  // Exactly one level under the root: a subdirectory of a worker is not the worker.
  if (rel === "" || rel.startsWith("..") || rel.includes(sep)) {
    return undefined;
  }
  return rel;
}

/**
 * A path as it should be shown to the user: relative to the current directory,
 * which is how they referred to it in the first place. Falls back to the
 * absolute form when the relative one would climb out of the tree, where `../../`
 * chains stop being clearer than the truth.
 */
export function displayPath(cwd: string, target: string): string {
  const rel = relative(resolve(cwd), resolve(target));
  if (rel === "") {
    return ".";
  }
  return rel.startsWith("..") ? target : rel;
}
