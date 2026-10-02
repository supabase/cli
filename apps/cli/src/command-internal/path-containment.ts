/**
 * Canonical-path containment shared by every consumer that resolves a user- or
 * checkout-supplied path and must keep it inside the project root: email template
 * `content_path` values and the `supabase/notebooks/` directory.
 */

import { lstatSync, readlinkSync, realpathSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// `readlinkSync` bypasses the OS's own `ELOOP` symlink-cycle detection when
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
export function isPathContainedInRoot(root: string, candidatePath: string): boolean {
  const rel = relative(root, candidatePath);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/**
 * Canonicalizes `path` when it exists (per `lstatSync`), or returns `undefined` so
 * {@link canonicalPathForContainment} keeps walking up to an existing ancestor.
 *
 * `realpathSync` can throw for a path that exists (dangling symlink, `EACCES` target, `ELOOP`),
 * so such a symlink is followed one hop by hand, bounded by {@link MAX_SYMLINK_FOLLOW_DEPTH},
 * and its target canonicalized in turn; a chain still unresolved at the bound returns the lexical
 * path so a loop is rejected rather than accepted. An `lstatSync` failure unrelated to the path
 * itself (unreadable ancestor, over-long name) counts as "doesn't exist yet", so an honest in-root
 * path behind a restricted ancestor isn't falsely rejected.
 */
function canonicalizeExistingPath(path: string, depth: number): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    // Wraps only the `lstatSync` call, not the recursive canonicalization below it: including
    // that would let a deep throw there return the outer symlink's own lexically-in-root path,
    // turning a rejection into an accept.
    let entry: Stats | undefined;
    try {
      entry = lstatSync(path, { throwIfNoEntry: false });
    } catch {
      return undefined;
    }
    if (entry === undefined) return undefined;
    if (entry.isSymbolicLink()) {
      if (depth < MAX_SYMLINK_FOLLOW_DEPTH) {
        const target = readlinkSync(path);
        return canonicalPathForContainment(
          isAbsolute(target) ? target : join(dirname(path), target),
          depth + 1,
        );
      }
      // Must not be treated as "doesn't exist": returning `undefined` here would let the
      // ancestor walk-up canonicalize past the whole unresolvable loop and silently accept it
      // instead of failing closed.
      return path;
    }
    // A non-symlink entry `lstat` can see but `realpath` can't resolve — e.g. a chmod-000
    // directory on Darwin, whose realpath(3) needs search permission on itself, not just its
    // parent. Deferred to the same "doesn't exist yet" ancestor walk-up as a genuinely missing
    // path, since a plain entry can't recurse into a loop.
    return undefined;
  }
}

/**
 * Canonicalizes `path` for the containment check, tolerating a path (or an ancestor of it)
 * that genuinely doesn't exist yet — the normal case for a missing template file or a
 * notebooks directory a pull is about to create, which should surface as a missing-file error,
 * not a containment error. Walks up to the deepest existing ancestor, resolves it with
 * `realpathSync` (dereferencing any symlinks, including a symlinked project root itself), then
 * re-appends the missing tail lexically. The walk-up is iterative, not recursive, so it stays
 * correct against a pathologically long chain of missing ancestors; each ancestor still goes
 * through {@link canonicalizeExistingPath}, so an intermediate dangling/unsearchable/looping
 * symlink is followed rather than lexically skipped.
 */
export function canonicalPathForContainment(path: string, depth = 0): string {
  const canonical = canonicalizeExistingPath(path, depth);
  if (canonical !== undefined) return canonical;

  const tail: string[] = [basename(path)];
  let current = dirname(path);
  for (;;) {
    const ancestorCanonical = canonicalizeExistingPath(current, depth);
    if (ancestorCanonical !== undefined) {
      return tail.reduceRight((acc, name) => join(acc, name), ancestorCanonical);
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolve(tail.reduceRight((acc, name) => join(acc, name), current));
    }
    tail.push(basename(current));
    current = parent;
  }
}
