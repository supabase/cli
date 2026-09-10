import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Effect, FileSystem, Option } from "effect";
import { InvalidWorkerSourceError } from "./workers.errors.ts";

/**
 * A worker's canonical location is `supabase/workers/<name>/`, mirroring `supabase/functions/<slug>/`
 * — the directory name doubles as the worker's name, so no separate name-to-directory lookup
 * exists. `[workers.<name>] source` (relative to the project root) is the only way to point a
 * worker's code elsewhere.
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
 * `target` with every symlink resolved, walking up to the deepest existing ancestor since
 * `realPath` fails on a path that doesn't exist yet — the point here is to vet a destination
 * before creating it.
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
 * Confines a resolved worker path to the project by comparing canonicalized paths, not raw
 * strings — a symlink such as `packages/external -> /other-repo` could otherwise let `--source
 * packages/external/api` write outside the project. The project root is canonicalized too, since
 * it may itself sit behind a symlink (macOS `/tmp`, most CI checkouts). Returns the path as given,
 * not canonicalized, so it displays and persists as the user typed it.
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
 * Resolves `--source` against the directory it was typed in and validates it before anything is
 * written: a value naming the project root, `supabase/`, or anywhere outside the project is
 * refused, since the resolved path is where the starter files land. `source` may point anywhere
 * inside the project except `functions/` and `migrations/`, which the CLI already owns.
 */
export const resolveWorkerSource = Effect.fnUntraced(function* (options: {
  readonly projectRoot: string;
  readonly cwd: string;
  readonly raw: string;
}) {
  const suggestion =
    "Point --source at a directory inside the project, for example --source packages/api.";

  // A directory name may legally start or end with a space on Unix, so whitespace isn't trimmed
  // (only the trailing path separator is) — trimming could silently retarget the scaffold.
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
 * A worker's source directory: `[workers.<name>] source` when one is recorded (resolved against
 * the project root), otherwise the default directory. Both are confined, not just resolved —
 * `source` comes from a committed `config.toml`, so a checkout carrying `source = "../../.."` or
 * an absolute path must still be rejected, and a symlinked `supabase/workers` can't escape either.
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
      : `supabase/workers, or a directory above it, is a symlink leading outside the project. Replace it with a real directory, or record [workers.${options.name}] source as a directory inside the project.`,
  });
});

/**
 * A path as it should be shown to the user: relative to the current directory. Falls back to the
 * absolute form when the relative one would climb out of the tree, where `../../` chains stop
 * being clearer than the truth.
 */
export function displayPath(cwd: string, target: string): string {
  const rel = relative(resolve(cwd), resolve(target));
  if (rel === "") {
    return ".";
  }
  return rel.startsWith("..") ? target : rel;
}
