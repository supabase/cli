import { Effect, FileSystem, Option, Path } from "effect";
import { InvalidComputeSourceError } from "./compute.errors.ts";

/**
 * A compute's canonical location is `supabase/compute/<name>/`, mirroring `supabase/functions/<slug>/`
 * — the directory name doubles as the compute's name, so no separate name-to-directory lookup
 * exists. `[compute.<name>] source` (relative to the project root) is the only way to point a
 * compute's code elsewhere.
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
 * `target` with every symlink resolved, walking up to the deepest existing ancestor since
 * `realPath` fails on a path that doesn't exist yet — the point here is to vet a destination
 * before creating it.
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
 * Confines a resolved compute path to the project by comparing canonicalized paths, not raw
 * strings — a symlink such as `packages/external -> /other-repo` could otherwise let `--source
 * packages/external/api` write outside the project. The project root is canonicalized too, since
 * it may itself sit behind a symlink (macOS `/tmp`, most CI checkouts). Returns the path as given,
 * not canonicalized, so it displays and persists as the user typed it.
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
 * Resolves `--source` against the directory it was typed in and validates it before anything is
 * written: a value naming the project root, `supabase/`, or anywhere outside the project is
 * refused, since the resolved path is where the starter files land. `source` may point anywhere
 * inside the project except `functions/` and `migrations/`, which the CLI already owns.
 */
export const resolveComputeSource = Effect.fnUntraced(function* (options: {
  readonly projectRoot: string;
  readonly cwd: string;
  readonly raw: string;
}) {
  const path = yield* Path.Path;
  const suggestion =
    "Point --source at a directory inside the project, for example --source packages/api.";

  // A directory name may legally start or end with a space on Unix, so whitespace isn't trimmed
  // (only the trailing path separator is) — trimming could silently retarget the scaffold.
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
 * A compute's source directory: `[compute.<name>] source` when one is recorded (resolved against
 * the project root), otherwise the default directory. Both are confined, not just resolved —
 * `source` comes from a committed `config.toml`, so a checkout carrying `source = "../../.."` or
 * an absolute path must still be rejected, and a symlinked `supabase/compute` can't escape either.
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
 * A path as it should be shown to the user: relative to the current directory. Falls back to the
 * absolute form when the relative one would climb out of the tree, where `../../` chains stop
 * being clearer than the truth.
 */
export function displayPath(path: Path.Path, cwd: string, target: string): string {
  const rel = path.relative(path.resolve(cwd), path.resolve(target));
  if (rel === "") {
    return ".";
  }
  return rel.startsWith("..") ? target : rel;
}
