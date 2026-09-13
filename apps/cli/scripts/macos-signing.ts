/**
 * macOS code-signing identifiers, shared by the signer (`build.ts`) and its verifier so both
 * agree. `bun build --compile` and the Go linker emit an ad-hoc signature that macOS 26+ AMFI
 * SIGKILLs at launch (GitHub #5556); re-signing with a full ad-hoc signature fixes it without
 * Apple credentials.
 */
export type MacBinaryName = "supabase" | "supabase-go";

export const MACOS_IDENTIFIERS: Record<MacBinaryName, string> = {
  supabase: "com.supabase.cli",
  "supabase-go": "com.supabase.cli-go",
};

/**
 * Looks up the expected identifier for a binary basename, or `undefined` if it isn't a signed
 * macOS binary, so callers verifying an arbitrary path fail closed.
 */
export function macIdentifierFor(binary: string): string | undefined {
  return binary === "supabase" || binary === "supabase-go" ? MACOS_IDENTIFIERS[binary] : undefined;
}

/** The macOS binaries shipped for the CLI: the Bun binary and its Go sidecar. */
export function darwinBinaries(): MacBinaryName[] {
  return ["supabase", "supabase-go"];
}
