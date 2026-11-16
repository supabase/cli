import { releaseTypeForTitle } from "../../apps/cli/scripts/analyze-commits-title.js";

export const BREAKING_TARGET = "next";

export type TitleGuardInput = {
  title: string;
  baseRef: string;
  headRef?: string;
  headRepo?: string;
  baseRepo?: string;
};
export type TitleGuardResult = { ok: true } | { ok: false; message: string };

const stripRef = (ref: string) => ref.replace(/^refs\/heads\//, "");

export function evaluateTitle({
  title,
  baseRef,
  headRef,
  headRepo,
  baseRepo,
}: TitleGuardInput): TitleGuardResult {
  const base = stripRef(baseRef);
  if (releaseTypeForTitle(title) !== "major" || base === BREAKING_TARGET) {
    return { ok: true };
  }
  // The next -> develop cut lands by fast-forward, so its title never becomes a release commit.
  // A fork branch named `next` must not qualify.
  const sameRepo = headRepo !== undefined && headRepo === baseRepo;
  if (
    sameRepo &&
    headRef !== undefined &&
    stripRef(headRef) === BREAKING_TARGET &&
    base === "develop"
  ) {
    return { ok: true };
  }
  return {
    ok: false,
    message: `Breaking (\`!\`) titles must target \`${BREAKING_TARGET}\`, not \`${base}\`; retarget this pull request to \`${BREAKING_TARGET}\` or drop the \`!\`.`,
  };
}

if (import.meta.main) {
  const result = evaluateTitle({
    title: process.env.TITLE ?? "",
    baseRef: process.env.BASE_REF ?? "",
    headRef: process.env.HEAD_REF || undefined,
    headRepo: process.env.HEAD_REPO || undefined,
    baseRepo: process.env.BASE_REPO || undefined,
  });
  if (!result.ok) {
    console.log(`::error title=Breaking title on wrong branch::${result.message}`);
    process.exit(1);
  }
}
