/**
 * macOS code-signing identifiers per shipped binary. Single source of truth
 * shared by the signer (`build.ts`) and the verifier (the macOS smoke-test
 * helper) so the identifier a binary is signed with can't drift from the one it
 * is verified against.
 *
 * Why signing exists at all: `bun build --compile` and the Go linker emit a
 * degenerate "linker-signed" ad-hoc signature (identifier `a.out`, no
 * requirements blob) that macOS 26+ AMFI rejects, SIGKILLing the process at
 * launch (CLI-1621 / GitHub #5556). Re-signing with a full ad-hoc signature —
 * a complete CodeDirectory + RequirementSet + (empty) CMS, the same shape
 * `codesign --sign -` produces — fixes it without any Apple credentials. Phase
 * 2 will add Developer ID signing + notarization on top.
 */
export type MacBinaryName = "supabase" | "supabase-go";

export const MACOS_IDENTIFIERS: Record<MacBinaryName, string> = {
  supabase: "com.supabase.cli",
  "supabase-go": "com.supabase.cli-go",
};

/**
 * Look up the expected identifier for a binary basename. Returns `undefined`
 * for anything that isn't a signed macOS binary, so callers verifying an
 * arbitrary file path can fail closed.
 */
export function macIdentifierFor(binary: string): string | undefined {
  return binary === "supabase" || binary === "supabase-go" ? MACOS_IDENTIFIERS[binary] : undefined;
}

/**
 * The macOS binaries shipped for a given shell. The legacy shell ships the Go
 * sidecar alongside the Bun SFE; the next shell is SFE-only. Keeping this here
 * (rather than reading a module-level `shell` inside the signer) lets the signer
 * stand on its own and makes the legacy/next split explicit in one place.
 */
export function darwinBinariesForShell(shell: "legacy" | "next"): MacBinaryName[] {
  return shell === "legacy" ? ["supabase", "supabase-go"] : ["supabase"];
}
