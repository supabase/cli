import { Effect } from "effect";
import { pathMatch } from "../../command-internal/path-match.ts";
import { InvalidComputeExcludeError } from "./compute.errors.ts";

/**
 * `[compute.<name>] exclude` — the patterns that keep a path out of the uploaded build
 * context.
 *
 * Read the way `.gitignore` reads them, because that is the vocabulary the paths people want
 * gone are already written in: a pattern without `/` matches that name at any depth, one with
 * `/` is anchored at the source directory, a trailing `/` matches directories only, and `**`
 * spans directories. Within one path segment the syntax is the CLI's existing glob matcher
 * ({@link pathMatch}), so `*`, `?` and `[a-z]` mean here what they already mean in
 * `[db.seed] sql_paths`.
 *
 * Re-inclusion (`!`) is absent rather than pending: excluding a directory stops the walk
 * there, so the pattern that would re-admit something beneath it can never be reached, and a
 * setting that silently does nothing is worse than one that isn't offered.
 */

/** A `/`-separated pattern, ready to match against a path relative to the source directory. */
interface ExcludePattern {
  readonly raw: string;
  /** Matched against the whole relative path rather than a single name. */
  readonly anchored: boolean;
  /** Written with a trailing `/`, so it passes over a file of the same name. */
  readonly directoryOnly: boolean;
  readonly segments: ReadonlyArray<string>;
}

export interface ComputeExcludeMatcher {
  /** Whether any pattern is in play, so callers can skip reporting a count of zero. */
  readonly active: boolean;
  readonly excludes: (relativePath: string, isDirectory: boolean) => boolean;
}

/** Excludes nothing — a compute that records no patterns, and the default. */
export const NO_COMPUTE_EXCLUSIONS: ComputeExcludeMatcher = {
  active: false,
  excludes: () => false,
};

/** `**` is only a segment spanner as a whole segment; `a**b` is the single-segment `a*b`. */
const SPANNER = "**";

/**
 * Whether every glob operator in one segment is well-formed. `pathMatch` reports a malformed
 * character class rather than throwing, and keeps walking the pattern after a match fails, so
 * matching against the empty string reaches every operator in it.
 */
function isWellFormedSegment(segment: string): boolean {
  return !pathMatch(segment, "").badPattern;
}

/**
 * Matches pattern segments against path segments, with `**` standing for zero or more of the
 * latter. An anchored pattern has to consume the path entirely: a directory that matches is
 * never descended into, so a pattern needs no separate rule for what sits underneath it.
 */
function matchSegments(pattern: ReadonlyArray<string>, segments: ReadonlyArray<string>): boolean {
  if (pattern.length === 0) {
    return segments.length === 0;
  }
  const [head, ...rest] = pattern;
  if (head === SPANNER) {
    for (let skipped = 0; skipped <= segments.length; skipped++) {
      if (matchSegments(rest, segments.slice(skipped))) {
        return true;
      }
    }
    return false;
  }
  const [first, ...remaining] = segments;
  if (first === undefined) {
    return false;
  }
  return pathMatch(head ?? "", first).matched && matchSegments(rest, remaining);
}

/**
 * Reads the recorded patterns into a matcher, refusing any the CLI cannot act on.
 *
 * Every refusal names the pattern and the compute, since the whole point of the setting is
 * that a file the user expected gone is gone — a pattern quietly read as something else, or
 * skipped, would upload the file it was written to withhold.
 */
export const compileComputeExclude = Effect.fnUntraced(function* (options: {
  readonly name: string;
  readonly patterns: ReadonlyArray<string> | undefined;
}) {
  const recorded = options.patterns;
  if (recorded === undefined || recorded.length === 0) {
    return NO_COMPUTE_EXCLUSIONS;
  }

  const refuse = (raw: string, why: string, suggestion: string) =>
    new InvalidComputeExcludeError({
      detail: `[compute.${options.name}] exclude pattern "${raw}" ${why}.`,
      suggestion,
    });

  const patterns: Array<ExcludePattern> = [];
  for (const raw of recorded) {
    if (raw.startsWith("!")) {
      return yield* refuse(
        raw,
        "re-includes a path, which the compute build context does not support",
        `Drop the pattern, or narrow the pattern it was meant to carve out of under [compute.${options.name}] exclude.`,
      );
    }

    const directoryOnly = raw.endsWith("/");
    // A leading `/` anchors without contributing a segment, and so does a `/` anywhere inside
    // the pattern — both are stripped before splitting, so `segments` never holds a blank.
    const anchored = raw.startsWith("/") || raw.slice(0, -1).includes("/");
    const body = raw.replace(/\/+$/, "").replace(/^\/+/, "");

    if (body === "") {
      return yield* refuse(
        raw,
        "names no path",
        `Remove it from [compute.${options.name}] exclude, or replace it with the path to leave out, for example "node_modules".`,
      );
    }

    const segments = body.split("/");
    const malformed = segments.find(
      (segment) => segment !== SPANNER && (segment === "" || !isWellFormedSegment(segment)),
    );
    if (malformed !== undefined) {
      return yield* refuse(
        raw,
        segments.includes("")
          ? "has an empty path segment"
          : `has a malformed character class in "${malformed}"`,
        `Fix the pattern under [compute.${options.name}] exclude, or replace it with a plain path such as "node_modules".`,
      );
    }

    patterns.push({ raw, anchored, directoryOnly, segments });
  }

  return {
    active: true,
    excludes: (relativePath, isDirectory) => {
      const segments = relativePath.split("/");
      const name = segments[segments.length - 1] ?? "";
      return patterns.some((pattern) => {
        if (pattern.directoryOnly && !isDirectory) {
          return false;
        }
        return pattern.anchored
          ? matchSegments(pattern.segments, segments)
          : // An unanchored pattern is a single segment by construction, so it is the name
            // that answers it, at whatever depth the walk found it.
            pathMatch(pattern.segments[0] ?? "", name).matched;
      });
    },
  } satisfies ComputeExcludeMatcher;
});
