import { Effect, FileSystem, Option, Path } from "effect";
import { InvalidComputeSourceError } from "./compute.errors.ts";

/**
 * The project layout every compute command resolves against:
 *
 *   supabase/
 *     config.toml          project config — compute record `[compute.<name>]` here
 *     compute/<name>/      one directory per compute; the name IS the directory
 *
 * This mirrors `supabase/functions/<slug>/` on purpose: `supabase compute` is a
 * sibling of `supabase functions`, not a separate tool with its own
 * conventions. A compute's name and its directory are the same fact, so
 * `push`/`status`/`delete <name>` needs no separate lookup, and running from
 * inside the directory needs no name at all.
 *
 * `supabase/compute/` is where they live. One compute whose code belongs
 * somewhere else uses `[compute.<name>] source`, relative to the project root,
 * which is the only key that moves anything.
 */

/** The directory compute live in, under `supabase/`. */
const COMPUTE_DIR = "compute";

/**
 * Directories under `supabase/` the CLI already owns, so no compute's `source`
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

/** `supabase/compute/` — where compute live, resolved against the project. */
export function computeRootDir(path: Path.Path, projectRoot: string): string {
  return path.join(projectRoot, "supabase", COMPUTE_DIR);
}

/** Whether `candidate` is `parent` itself or sits underneath it. */
function isAtOrUnder(path: Path.Path, parent: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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
  const path = yield* Path.Path;
  const absolute = path.resolve(target);
  const pending: Array<string> = [];
  let cursor = absolute;

  for (;;) {
    const real = yield* fs.realPath(cursor).pipe(Effect.option);
    if (Option.isSome(real)) {
      return pending.length === 0 ? real.value : path.join(real.value, ...pending);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      // Walked to the filesystem root without finding anything that exists.
      return absolute;
    }
    pending.unshift(path.basename(cursor));
    cursor = parent;
  }
});

/**
 * Confine a resolved compute path to the project, on the filesystem's terms
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
export const confineComputePath = Effect.fnUntraced(function* (options: {
  readonly projectRoot: string;
  readonly target: string;
  /** How the path is named in the error, e.g. `--source "packages/api"`. */
  readonly subject: string;
  readonly suggestion: string;
}) {
  const path = yield* Path.Path;
  const refuse = (why: string) =>
    Effect.fail(
      new InvalidComputeSourceError({
        detail: `${options.subject} ${why}.`,
        suggestion: options.suggestion,
      }),
    );

  const projectRoot = yield* canonicalize(options.projectRoot);
  const target = yield* canonicalize(options.target);
  const supabaseDir = path.join(projectRoot, "supabase");

  if (target === projectRoot) {
    return yield* refuse("is the project root itself");
  }
  if (!isAtOrUnder(path, projectRoot, target)) {
    return yield* refuse("resolves outside the project");
  }
  if (target === supabaseDir) {
    return yield* refuse("is the supabase directory itself");
  }
  for (const owned of RESERVED_SUPABASE_DIRS) {
    if (isAtOrUnder(path, path.join(supabaseDir, owned), target)) {
      return yield* refuse(`is inside supabase/${owned}/, which the Supabase CLI already owns`);
    }
  }
  for (const owned of RESERVED_SUPABASE_FILES) {
    if (target === path.join(supabaseDir, owned)) {
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
 * `source` is the key that may leave the compute directory, but not the project;
 * `functions/` and `migrations/` are refused because the CLI already owns them,
 * and a compute scaffolded on top would be read as a function or a migration.
 */
export const resolveComputeSource = Effect.fnUntraced(function* (options: {
  readonly projectRoot: string;
  readonly cwd: string;
  readonly raw: string;
}) {
  const path = yield* Path.Path;
  const suggestion =
    "Point --source at a directory inside the project, for example --source packages/api.";

  // Whitespace is not trimmed. A directory name may legally begin or end with a
  // space on Unix, and the shell only delivers one in a single argv entry if the
  // user quoted it — so trimming would silently retarget the scaffold at a
  // neighbouring directory. Only the trailing separator, which is syntax rather
  // than part of the name, comes off. An argument that is nothing but
  // whitespace is refused rather than trimmed into something else.
  if (options.raw.trim() === "") {
    return yield* new InvalidComputeSourceError({
      detail: `--source "${options.raw}" is empty.`,
      suggestion,
    });
  }

  return yield* confineComputePath({
    projectRoot: options.projectRoot,
    target: path.resolve(options.cwd, options.raw.replace(/[/\\]+$/, "")),
    subject: `--source "${options.raw}"`,
    suggestion,
  });
});

/** A compute's default directory: `supabase/compute/<name>/`. */
export function computeDir(path: Path.Path, projectRoot: string, name: string): string {
  return path.join(computeRootDir(path, projectRoot), name);
}

/**
 * A compute's source directory: `[compute.<name>] source` when one is recorded,
 * resolved against the project root, otherwise the default directory.
 *
 * Confined, not just resolved. `source` arrives from `config.toml`, which is
 * committed and shared — so it is as much an input as `--source` is, and a
 * checkout carrying `source = "../../.."` or an absolute path would otherwise
 * have `push` package and upload a directory that has nothing to do with the
 * project. The default directory goes through the same guard so a symlinked
 * `supabase/compute` cannot escape either.
 */
export const computeSourceDir = Effect.fnUntraced(function* (options: {
  readonly projectRoot: string;
  readonly defaultDir: string;
  readonly name: string;
  readonly configuredSource: string | undefined;
}) {
  const path = yield* Path.Path;
  const configured = options.configuredSource;
  const recorded = configured !== undefined && configured !== "";

  return yield* confineComputePath({
    projectRoot: options.projectRoot,
    target: recorded ? path.resolve(options.projectRoot, configured) : options.defaultDir,
    subject: recorded
      ? `[compute.${options.name}] source "${configured}"`
      : `The default directory for "${options.name}"`,
    suggestion: recorded
      ? `Set [compute.${options.name}] source to a directory inside the project, relative to the project root.`
      : `supabase/compute, or a directory above it, is a symlink leading outside the project. Replace it with a real directory, or record [compute.${options.name}] source as a directory inside the project.`,
  });
});

/**
 * A path as it should be shown to the user: relative to the current directory,
 * which is how they referred to it in the first place. Falls back to the
 * absolute form when the relative one would climb out of the tree, where `../../`
 * chains stop being clearer than the truth.
 */
export function displayPath(path: Path.Path, cwd: string, target: string): string {
  const rel = path.relative(path.resolve(cwd), path.resolve(target));
  if (rel === "") {
    return ".";
  }
  return rel.startsWith("..") ? target : rel;
}
