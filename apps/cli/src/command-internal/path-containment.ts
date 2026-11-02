/**
 * Canonical-path containment shared by every consumer that resolves a user- or
 * checkout-supplied path and must keep it inside the project root: email template
 * `content_path` values and the `supabase/notebooks/` directory.
 */

import { Effect, FileSystem, Option, Path, type PlatformError, Predicate, Result } from "effect";

// `readLink` bypasses the OS's own `ELOOP` symlink-cycle detection when
// manually following a dangling/unsearchable/looping symlink one hop at a
// time (see `canonicalizeExistingPath` below), so that manual follow needs
// its own explicit bound.
const MAX_SYMLINK_FOLLOW_DEPTH = 40;

/**
 * Whether `candidatePath` resolves inside (or exactly to) `root`. Both
 * arguments must already be canonicalized (see {@link canonicalPathForContainment}).
 * Only rejects a genuine `..` traversal — a same-level sibling whose name
 * happens to start with two dots (e.g. `..templates`) is a distinct,
 * in-root path and must not be rejected.
 */
export function isPathContainedInRoot(
  path: Path.Path,
  root: string,
  candidatePath: string,
): boolean {
  const rel = path.relative(root, candidatePath);
  return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

/**
 * Canonicalizes `path` when it exists (per `realPath`/`readLink`), or returns `undefined` so
 * {@link canonicalPathForContainment} keeps walking up to an existing ancestor.
 *
 * `realPath` can fail for a path that exists (dangling symlink, `EACCES` target, `ELOOP`),
 * so such a symlink is followed one hop by hand, bounded by {@link MAX_SYMLINK_FOLLOW_DEPTH},
 * and its target canonicalized in turn; a chain still unresolved at the bound returns the lexical
 * path so a loop is rejected rather than accepted. A `readLink` failure unrelated to the path
 * itself (unreadable ancestor, over-long name) counts as "doesn't exist yet", so an honest in-root
 * path behind a restricted ancestor isn't falsely rejected.
 */
const canonicalizeExistingPath = Effect.fnUntraced(function* (path: string, depth: number) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const canonical = yield* fs.realPath(path).pipe(Effect.option);
  if (Option.isSome(canonical)) return canonical.value;
  /* `FileSystem` has no `lstat`, so `readLink` stands in: it succeeds only for a symlink, and a
     symlink whose own mode denies reading it fails with `EACCES` under a searchable parent. */
  const link = yield* fs.readLink(path).pipe(Effect.result);
  const isSymbolicLink =
    Result.isSuccess(link) ||
    (Predicate.isTagged(link.failure.reason, "PermissionDenied") &&
      (yield* fs.stat(`${pathService.dirname(path)}${pathService.sep}.`).pipe(Effect.isSuccess)));
  if (isSymbolicLink) {
    if (depth < MAX_SYMLINK_FOLLOW_DEPTH) {
      const target = yield* Effect.fromResult(link);
      return yield* canonicalPathForContainment(
        pathService.isAbsolute(target)
          ? target
          : pathService.join(pathService.dirname(path), target),
        depth + 1,
      );
    }
    // Must not be treated as "doesn't exist": returning `undefined` here would let the
    // ancestor walk-up canonicalize past the whole unresolvable loop and silently accept it
    // instead of failing closed.
    return path;
  }
  // A non-symlink entry that exists but `realPath` can't resolve — e.g. a chmod-000
  // directory on Darwin, whose realpath(3) needs search permission on itself, not just its
  // parent. Deferred to the same "doesn't exist yet" ancestor walk-up as a genuinely missing
  // path, since a plain entry can't recurse into a loop.
  return undefined;
});

/**
 * Canonicalizes `path` for the containment check, tolerating a path (or an ancestor of it)
 * that genuinely doesn't exist yet — the normal case for a missing template file or a
 * notebooks directory a pull is about to create, which should surface as a missing-file error,
 * not a containment error. Walks up to the deepest existing ancestor, resolves it with
 * `realPath` (dereferencing any symlinks, including a symlinked project root itself), then
 * re-appends the missing tail lexically. The walk-up is iterative, not recursive, so it stays
 * correct against a pathologically long chain of missing ancestors; each ancestor still goes
 * through {@link canonicalizeExistingPath}, so an intermediate dangling/unsearchable/looping
 * symlink is followed rather than lexically skipped.
 */
export const canonicalPathForContainment: (
  path: string,
  depth?: number,
) => Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =
  Effect.fnUntraced(function* (path: string, depth = 0) {
    const pathService = yield* Path.Path;
    const canonical = yield* canonicalizeExistingPath(path, depth);
    if (canonical !== undefined) return canonical;

    const tail: string[] = [pathService.basename(path)];
    let current = pathService.dirname(path);
    for (;;) {
      const ancestorCanonical = yield* canonicalizeExistingPath(current, depth);
      if (ancestorCanonical !== undefined) {
        return tail.reduceRight((acc, name) => pathService.join(acc, name), ancestorCanonical);
      }
      const parent = pathService.dirname(current);
      if (parent === current) {
        return pathService.resolve(
          tail.reduceRight((acc, name) => pathService.join(acc, name), current),
        );
      }
      tail.push(pathService.basename(current));
      current = parent;
    }
  });
