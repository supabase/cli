import { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { macIdentifierFor } from "../../scripts/macos-signing.ts";
import { jsonQuote, type ReleaseStepError, runCliEffect } from "./release-shell.ts";

export type SignatureCheckResult = {
  readonly passed: boolean;
  readonly detail: string;
};

/**
 * Verify a macOS binary carries a valid signature. Runs on the macOS smoke-test runners via
 * `codesign`/`spctl`.
 *
 * Phase 1 expects a full ad-hoc signature with our identifier and no `linker-signed` flag — the
 * shape that avoids the macOS 26+ launch SIGKILL. When a Developer ID signature is present
 * (Phase 2), it additionally checks the hardened-runtime flag and that Gatekeeper accepts a
 * quarantined copy, which validates the online notarization ticket.
 */
export const verifyMacSignature = Effect.fn("MacosSignature.verifyMacSignature")(function* (
  binPath: string,
): Effect.fn.Return<
  SignatureCheckResult,
  ReleaseStepError | PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path;
  const binary = path.basename(binPath);
  const expectedId = macIdentifierFor(binary);
  if (!expectedId) {
    return { passed: false, detail: `no expected identifier configured for ${binary}` };
  }

  const verify = yield* runCliEffect("codesign", ["--verify", "--strict", "--verbose=2", binPath]);
  if (verify.exitCode !== 0) {
    return {
      passed: false,
      detail: `codesign --verify --strict failed: exit=${verify.exitCode}, stderr=${yield* jsonQuote(verify.stderr)}`,
    };
  }

  // codesign writes the signature display to stderr.
  const display = yield* runCliEffect("codesign", ["-dvv", binPath]);
  const info = [display.stdout, display.stderr].filter(Boolean).join("\n");

  // Match the whole identifier value (codesign prints `Identifier=<id>` on its
  // own line) rather than substring-matching within the surrounding signature output.
  const actualId = info.match(/^Identifier=(.+)$/m)?.[1]?.trim();
  if (actualId !== expectedId) {
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
  return yield* verifyGatekeeperAcceptsQuarantined(binPath, expectedId);
});

/**
 * Copy the binary, mark it quarantined (as a fresh download would be), and ask
 * Gatekeeper to assess it. A notarized Developer ID binary passes; an
 * un-notarized one is rejected. Bare Mach-O binaries cannot be stapled, so this
 * exercises the online ticket lookup.
 */
const verifyGatekeeperAcceptsQuarantined = Effect.fnUntraced(function* (
  binPath: string,
  expectedId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const assessCopy = (dir: string) =>
    Effect.gen(function* () {
      const copy = path.join(dir, path.basename(binPath));
      yield* runCliEffect("cp", [binPath, copy]);
      yield* runCliEffect("xattr", ["-w", "com.apple.quarantine", "0081;00000000;smoke;", copy]);
      const assess = yield* runCliEffect("spctl", [
        "--assess",
        "--type",
        "execute",
        "--verbose=2",
        copy,
      ]);
      if (assess.exitCode !== 0) {
        return {
          passed: false,
          detail: `spctl rejected quarantined binary: exit=${assess.exitCode}, stderr=${yield* jsonQuote(assess.stderr)}`,
        };
      }
      return {
        passed: true,
        detail: `Developer ID + notarized signature ok (Identifier=${expectedId})`,
      };
    });
  /* `try { assess } finally { remove }`: a failed removal replaces the assessment's outcome. */
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const dir = yield* fs.makeTempDirectory({ prefix: "supabase-gatekeeper-" });
      const outcome = yield* Effect.exit(restore(assessCopy(dir)));
      yield* fs.remove(dir, { recursive: true, force: true });
      return yield* outcome;
    }),
  );
});
