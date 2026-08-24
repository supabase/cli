import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as PlatformError from "effect/PlatformError";
import { macIdentifierFor } from "../../scripts/macos-signing.ts";
import { runCliEffect } from "./release-shell.ts";

export type SignatureCheckResult = {
  readonly passed: boolean;
  readonly detail: string;
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
export const verifyMacSignatureEffect = (
  binPath: string,
): Effect.Effect<
  SignatureCheckResult,
  PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const binary = path.basename(binPath);
    const expectedId = macIdentifierFor(binary);
    if (!expectedId) {
      return { passed: false, detail: `no expected identifier configured for ${binary}` };
    }

    const verify = yield* runCliEffect("codesign", [
      "--verify",
      "--strict",
      "--verbose=2",
      binPath,
    ]);
    if (verify.exitCode !== 0) {
      return {
        passed: false,
        detail: `codesign --verify --strict failed: exit=${verify.exitCode}, stderr=${verify.stderr}`,
      };
    }

    // codesign writes the signature display to stderr.
    const display = yield* runCliEffect("codesign", ["-dvv", binPath]);
    const info = [display.stdout, display.stderr].filter(Boolean).join("\n");

    // Match the whole identifier value (codesign prints `Identifier=<id>` on its
    // own line) so the SFE's `com.supabase.cli` can't satisfy the sidecar's
    // `com.supabase.cli-go` by substring.
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

/** Promise facade for the macOS smoke script's non-Effect executable edge. */
export function verifyMacSignature(binPath: string): Promise<SignatureCheckResult> {
  return Effect.runPromise(
    verifyMacSignatureEffect(binPath).pipe(Effect.provide(BunServices.layer)),
  );
}

/**
 * Copy the binary, mark it quarantined (as a fresh download would be), and ask
 * Gatekeeper to assess it. A notarized Developer ID binary passes; an
 * un-notarized one is rejected. Bare Mach-O binaries cannot be stapled, so this
 * exercises the online ticket lookup.
 */
function verifyGatekeeperAcceptsQuarantined(
  binPath: string,
  expectedId: string,
): Effect.Effect<
  SignatureCheckResult,
  PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectory({ prefix: "supabase-gatekeeper-" });
    const copy = path.join(dir, path.basename(binPath));
    return yield* Effect.gen(function* () {
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
          detail: `spctl rejected quarantined binary: exit=${assess.exitCode}, stderr=${assess.stderr}`,
        };
      }
      return {
        passed: true,
        detail: `Developer ID + notarized signature ok (Identifier=${expectedId})`,
      };
    }).pipe(Effect.ensuring(fs.remove(dir, { recursive: true }).pipe(Effect.ignore)));
  });
}
