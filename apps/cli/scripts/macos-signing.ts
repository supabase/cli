/**
 * macOS code-signing identifiers, shared by the signer (`build.ts`) and its verifier so both
 * agree. `bun build --compile` emits an ad-hoc signature that macOS 26+ AMFI SIGKILLs at launch
 * (GitHub #5556); re-signing with a full ad-hoc signature fixes it without Apple credentials.
 */
export type MacBinaryName = "supabase";

export const MACOS_IDENTIFIERS: Record<MacBinaryName, string> = {
  supabase: "com.supabase.cli",
};

/**
 * Looks up the expected identifier for a binary basename, or `undefined` if it isn't a signed
 * macOS binary, so callers verifying an arbitrary path fail closed.
 */
export function macIdentifierFor(binary: string): string | undefined {
  return binary === "supabase" ? MACOS_IDENTIFIERS[binary] : undefined;
}

/** The macOS binaries shipped for the CLI. */
export function darwinBinaries(): MacBinaryName[] {
  return ["supabase"];
}
