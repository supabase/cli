import { Effect } from "effect";
import { pathMatch } from "../../command-internal/path-match.ts";
import { InvalidComputeExcludeError } from "./compute.errors.ts";

/**
 * `[compute.<name>] exclude` — the patterns that keep a path out of the uploaded build
 * context, read the way `.gitignore` reads them, with one segment matched by the CLI's own
 * glob matcher ({@link pathMatch}).
 *
 * @see `../../commands/experimental/compute/push/SIDE_EFFECTS.md` — full semantics, the
 * refusals, and why re-inclusion (`!`) is not offered.
 */

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

/** Only a whole segment spans directories; `a**b` is the single-segment `a*b`. */
const SPANNER = "**";

/** `pathMatch` reaches every operator in a pattern even once a match has failed. */
function isWellFormedSegment(segment: string): boolean {
  return !pathMatch(segment, "").badPattern;
}

/** Adjacent spanners span exactly what one spans; left in, each retries the same suffixes. */
function collapseSpanners(segments: ReadonlyArray<string>): Array<string> {
  return segments.filter(
    (segment, index) => segment !== SPANNER || segments[index - 1] !== SPANNER,
  );
}

/**
 * Matches pattern segments against path segments. An anchored pattern consumes the path
 * entirely, since a matched directory is never descended into.
 */
function matchSegments(pattern: ReadonlyArray<string>, segments: ReadonlyArray<string>): boolean {
  if (pattern.length === 0) {
    return segments.length === 0;
  }
  const [head, ...rest] = pattern;
  if (head === SPANNER) {
    // A trailing `**` names what is inside a directory, so it must consume a segment or
    // pruning would take the directory too; elsewhere a spanner may span nothing.
    const fewest = rest.length === 0 ? 1 : 0;
    for (let skipped = fewest; skipped <= segments.length; skipped++) {
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
 * Reads the recorded patterns into a matcher, naming any the CLI cannot act on. A pattern read
 * as something else, or skipped, would upload the file it was written to withhold.
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

    // Anchoring is decided after trailing separators come off, so `dist/` and `dist//` agree.
    const withoutTrailing = raw.replace(/\/+$/, "");
    const directoryOnly = withoutTrailing !== raw;
    const anchored = withoutTrailing.includes("/");
    const body = withoutTrailing.replace(/^\/+/, "");

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
          : // One verdict covers every malformed operator, so the segment is named, not a cause.
            `has malformed glob syntax in "${malformed}"`,
        `Fix the pattern under [compute.${options.name}] exclude, or replace it with a plain path such as "node_modules".`,
      );
    }

    patterns.push({ raw, anchored, directoryOnly, segments: collapseSpanners(segments) });
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
        // An unanchored pattern is a single segment, so the name answers it at any depth.
        return pattern.anchored
          ? matchSegments(pattern.segments, segments)
          : pathMatch(pattern.segments[0] ?? "", name).matched;
      });
    },
  } satisfies ComputeExcludeMatcher;
});
