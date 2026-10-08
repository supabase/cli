const MAINTENANCE_TAG = /^v[1-9]\d*\.stable$/;
const PUBLISHABLE_TAGS = new Set(["latest", "alpha", "beta", "next"]);

export function isPublishableNpmTag(tag: string): boolean {
  return PUBLISHABLE_TAGS.has(tag) || MAINTENANCE_TAG.test(tag);
}

export const PUBLISHABLE_NPM_TAGS_HINT = "latest, beta, next, alpha, or v<N>.stable";

/** Mirrors Homebrew's `Formulary.class_s`, so `supabase@2` becomes `SupabaseAT2`. */
export function homebrewClassName(formulaName: string): string {
  const capitalized = formulaName.charAt(0).toUpperCase() + formulaName.slice(1).toLowerCase();
  return capitalized
    .replace(/[-_.\s]([a-zA-Z0-9])/g, (_, char: string) => char.toUpperCase())
    .replaceAll("+", "x")
    .replace(/(.)@(\d)/, "$1AT$2");
}

/** A versioned formula (`supabase@2`) installs the same `bin/supabase` as the unversioned one. */
export function homebrewConflictsLine(formulaName: string): string | undefined {
  return /^[^@]+@\d+$/.test(formulaName)
    ? '  conflicts_with "supabase", because: "both install a `supabase` binary"'
    : undefined;
}

/** The release branch a tag was cut from; a stable tag off `main` belongs to its `v<N>.x` line. */
export function releaseBranchForTag(tag: string, onMain: boolean): string {
  if (tag.includes("-beta.")) return "develop";
  if (tag.includes("-next.")) return "next";
  if (tag.includes("-")) return "main";
  if (onMain) return "main";
  return `v${tag.replace(/^v/, "").split(".")[0]}.x`;
}

export function channelForTag(tag: string): "beta" | "next" | "alpha" | "latest" {
  if (tag.includes("-beta.")) return "beta";
  if (tag.includes("-next.")) return "next";
  if (tag.includes("-alpha.")) return "alpha";
  return "latest";
}
