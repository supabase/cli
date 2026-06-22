import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli } from "./release-shell.ts";

export type SignatureCheckResult = {
  readonly passed: boolean;
  readonly detail: string;
};

const EXPECTED_IDENTIFIERS: Record<string, string> = {
  supabase: "com.supabase.cli",
  "supabase-go": "com.supabase.cli-go",
};

/**
 * Verify a macOS binary carries a valid signature. Runs on the macOS smoke-test
 * runners via `codesign` / `spctl`.
 *
 * Phase 1 expects a full ad-hoc signature with our identifier and no
 * `linker-signed` flag — the shape that fixes the macOS 26+ launch SIGKILL
 * (CLI-1621 / GitHub #5556). When a Developer ID signature is present (Phase 2),
 * it additionally checks the hardened-runtime flag and that Gatekeeper accepts a
 * quarantined copy, which validates the online notarization ticket.
 */
export async function verifyMacSignature(binPath: string): Promise<SignatureCheckResult> {
  const binary = path.basename(binPath);
  const expectedId = EXPECTED_IDENTIFIERS[binary];
  if (!expectedId) {
    return { passed: false, detail: `no expected identifier configured for ${binary}` };
  }

  const verify = await runCli("codesign", ["--verify", "--strict", "--verbose=2", binPath]);
  if (verify.exitCode !== 0) {
    return {
      passed: false,
      detail: `codesign --verify --strict failed: exit=${verify.exitCode}, stderr=${JSON.stringify(verify.stderr)}`,
    };
  }

  // codesign writes the signature display to stderr.
  const display = await runCli("codesign", ["-dvv", binPath]);
  const info = [display.stdout, display.stderr].filter(Boolean).join("\n");

  if (!info.includes(`Identifier=${expectedId}`)) {
    return { passed: false, detail: `expected Identifier=${expectedId}, got:\n${info}` };
  }
  if (info.includes("linker-signed")) {
    return { passed: false, detail: `signature is still linker-signed:\n${info}` };
  }

  if (!info.includes("Authority=Developer ID Application")) {
    // Phase 1: full ad-hoc signature.
    if (!info.includes("Signature=adhoc") && !info.includes("adhoc")) {
      return { passed: false, detail: `expected an ad-hoc signature, got:\n${info}` };
    }
    return { passed: true, detail: `ad-hoc signature ok (Identifier=${expectedId})` };
  }

  // Phase 2: Developer ID + notarization.
  if (!info.includes("runtime")) {
    return {
      passed: false,
      detail: `Developer ID signature missing hardened runtime flag:\n${info}`,
    };
  }
  return verifyGatekeeperAcceptsQuarantined(binPath, expectedId);
}

/**
 * Copy the binary, mark it quarantined (as a fresh download would be), and ask
 * Gatekeeper to assess it. A notarized Developer ID binary passes; an
 * un-notarized one is rejected. Bare Mach-O binaries cannot be stapled, so this
 * exercises the online ticket lookup.
 */
async function verifyGatekeeperAcceptsQuarantined(
  binPath: string,
  expectedId: string,
): Promise<SignatureCheckResult> {
  const dir = await mkdtemp(path.join(tmpdir(), "supabase-gatekeeper-"));
  const copy = path.join(dir, path.basename(binPath));
  try {
    await runCli("cp", [binPath, copy]);
    await runCli("xattr", ["-w", "com.apple.quarantine", "0081;00000000;smoke;", copy]);
    const assess = await runCli("spctl", ["--assess", "--type", "execute", "--verbose=2", copy]);
    if (assess.exitCode !== 0) {
      return {
        passed: false,
        detail: `spctl rejected quarantined binary: exit=${assess.exitCode}, stderr=${JSON.stringify(assess.stderr)}`,
      };
    }
    return {
      passed: true,
      detail: `Developer ID + notarized signature ok (Identifier=${expectedId})`,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
