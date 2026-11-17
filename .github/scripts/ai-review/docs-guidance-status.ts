/** Snapshot provenance shared without loading the collector's runtime dependencies. */
export type GuidanceManifest = {
  status: "available" | "unavailable" | "not-applicable";
  sha: string | null;
  files: { path: string; localPath: string }[];
};

/** Conservative selection includes shared flag and example definitions, but not generated output. */
export function isReferenceSource(path: string): boolean {
  return (
    /^apps\/cli\/docs\/supabase\/.*\.md$/.test(path) ||
    path === "apps/cli/docs/templates/examples.yaml" ||
    (/^apps\/cli\/src\/.*\.ts$/.test(path) && !/\.(?:test|spec)\.ts$/.test(path))
  );
}

/** A deterministic status for the posted review, independent of model summaries. */
export function guidanceReviewStatus(snapshot: unknown): string {
  if (typeof snapshot === "object" && snapshot !== null && "status" in snapshot) {
    if (snapshot.status === "not-applicable")
      return "CLI reference prose guidance: not applicable (no reference sources changed).";
    if (
      snapshot.status === "available" &&
      "sha" in snapshot &&
      typeof snapshot.sha === "string" &&
      /^[0-9a-f]{40}$/.test(snapshot.sha)
    ) {
      return `CLI reference prose guidance: snapshot supabase/supabase@${snapshot.sha} supplied to reviewers (advisory, not a style pass).`;
    }
  }
  return "CLI reference prose guidance: unavailable. Ordinary code review continued; no style pass is claimed.";
}
