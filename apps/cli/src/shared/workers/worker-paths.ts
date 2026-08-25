import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Effect, FileSystem, Option } from "effect";
import { InvalidWorkerSourceError } from "./workers.errors.ts";

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
 * `supabase/workers/` is where they live. One worker whose code belongs
 * somewhere else uses `[workers.<name>] source`, relative to the project root,
 * which is the only key that moves anything.
 */

/** The directory workers live in, under `supabase/`. */
const WORKERS_DIR = "workers";

/**
 * Directories under `supabase/` the CLI already owns, so no worker's `source`
 * may name one: `functions` and `migrations` belong to other parts of the CLI,
 * and `.temp` holds CLI state including the linked-project reference.
 */
const RESERVED_SUPABASE_DIRS = ["functions", "migrations", ".temp"];

/**
 * Files directly under `supabase/` that the CLI owns. Refused separately from the
 * directories above, which do not cover them — `supabase/config.toml` sits
 * outside every reserved subdirectory.
 */
const RESERVED_SUPABASE_FILES = ["config.toml", "config.json"];

/** `supabase/workers/` — where workers live, resolved against the project. */
export function workersDir(projectRoot: string): string {
  return join(projectRoot, "supabase", WORKERS_DIR);
}

/** Whether `candidate` is `parent` itself or sits underneath it. */
function isAtOrUnder(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * `target` with every symlink in it resolved, as far as it exists.
 *
 * `realPath` fails outright on a path that is not there yet, and the whole point
 * of canonicalizing here is to vet a destination *before* creating it. So this
 * walks up to the deepest ancestor that does exist, resolves that, and re-joins
 * the part that doesn't.
 */
const canonicalize = Effect.fnUntraced(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const absolute = resolve(target);
  const pending: Array<string> = [];
  let cursor = absolute;

  for (;;) {
    const real = yield* fs.realPath(cursor).pipe(Effect.option);
    if (Option.isSome(real)) {
      return pending.length === 0 ? real.value : join(real.value, ...pending);
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      // Walked to the filesystem root without finding anything that exists.
      return absolute;
    }
    pending.unshift(basename(cursor));
    cursor = parent;
  }
});

/**
 * Confine a resolved worker path to the project, on the filesystem's terms
 * rather than the string's.
 *
 * A string comparison cannot see a symlink: `packages/external -> /other-repo`
 * makes `--source packages/external/api` write into `/other-repo`. So both the
 * target and the project root are canonicalized before comparing — the root too,
 * or a project under a symlink (macOS `/tmp` -> `/private/tmp`, most CI
 * checkouts) fails containment against itself.
 *
 * Returns the path as given, not the canonical form, so what gets displayed and
 * persisted stays the path the user named.
 */
export const confineWorkerPath = Effect.fnUntraced(function* (options: {
  readonly projectRoot: string;
  readonly target: string;
  /** How the path is named in the error, e.g. `--source "packages/api"`. */
  readonly subject: string;
  readonly suggestion: string;
}) {
  const refuse = (why: string) =>
    Effect.fail(
      new InvalidWorkerSourceError({
        detail: `${options.subject} ${why}.`,
        suggestion: options.suggestion,
      }),
    );

  const projectRoot = yield* canonicalize(options.projectRoot);
  const target = yield* canonicalize(options.target);
  const supabaseDir = join(projectRoot, "supabase");

  if (target === projectRoot) {
    return yield* refuse("is the project root itself");
  }
  if (!isAtOrUnder(projectRoot, target)) {
    return yield* refuse("resolves outside the project");
  }
  if (target === supabaseDir) {
    return yield* refuse("is the supabase directory itself");
  }
  for (const owned of RESERVED_SUPABASE_DIRS) {
    if (isAtOrUnder(join(supabaseDir, owned), target)) {
      return yield* refuse(`is inside supabase/${owned}/, which the Supabase CLI already owns`);
    }
  }
  for (const owned of RESERVED_SUPABASE_FILES) {
    if (target === join(supabaseDir, owned)) {
      return yield* refuse(`is supabase/${owned}, which the Supabase CLI already owns`);
    }
  }

  return options.target;
});

/**
 * `--source`, resolved against the directory the user typed it in and validated
 * before anything is written.
 *
 * The resolved path is where the starter files land, so a value naming the
 * project root, `supabase/`, or anywhere outside the project is refused.
 * `source` is the key that may leave the workers directory, but not the project;
 * `functions/` and `migrations/` are refused for the same reason `[workers] root`
 * refuses them.
 */
export const resolveWorkerSource = Effect.fnUntraced(function* (options: {
  readonly projectRoot: string;
  readonly cwd: string;
  readonly raw: string;
}) {
  const suggestion =
    "Point --source at a directory inside the project, for example --source packages/api.";

  // Whitespace is not trimmed. A directory name may legally begin or end with a
  // space on Unix, and the shell only delivers one in a single argv entry if the
  // user quoted it — so trimming would silently retarget the scaffold at a
  // neighbouring directory. Only the trailing separator, which is syntax rather
  // than part of the name, comes off. An argument that is nothing but
  // whitespace is refused rather than trimmed into something else.
  if (options.raw.trim() === "") {
    return yield* Effect.fail(
      new InvalidWorkerSourceError({
        detail: `--source "${options.raw}" is empty.`,
        suggestion,
      }),
    );
  }

  return yield* confineWorkerPath({
    projectRoot: options.projectRoot,
    target: resolve(options.cwd, options.raw.replace(/[/\\]+$/, "")),
    subject: `--source "${options.raw}"`,
    suggestion,
  });
});

/** A worker's default directory: `supabase/workers/<name>/`. */
export function workerDir(projectRoot: string, name: string): string {
  return join(workersDir(projectRoot), name);
}

/**
 * A worker's source directory: `[workers.<name>] source` when one is recorded,
 * resolved against the project root, otherwise the default directory.
 *
 * Confined, not just resolved. `source` arrives from `config.toml`, which is
 * committed and shared — so it is as much an input as `--source` is, and a
 * checkout carrying `source = "../../.."` or an absolute path would otherwise
 * have `push` package and upload a directory that has nothing to do with the
 * project. The default directory goes through the same guard so a symlinked
 * `[workers] root` cannot escape either.
 */
export const workerSourceDir = Effect.fnUntraced(function* (options: {
  readonly projectRoot: string;
  readonly defaultDir: string;
  readonly name: string;
  readonly configuredSource: string | undefined;
}) {
  const configured = options.configuredSource;
  const recorded = configured !== undefined && configured !== "";

  return yield* confineWorkerPath({
    projectRoot: options.projectRoot,
    target: recorded ? resolve(options.projectRoot, configured) : options.defaultDir,
    subject: recorded
      ? `[workers.${options.name}] source "${configured}"`
      : `The default directory for "${options.name}"`,
    suggestion: recorded
      ? `Set [workers.${options.name}] source to a directory inside the project, relative to the project root.`
      : "Point [workers] root at a directory inside supabase/.",
  });
});

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
