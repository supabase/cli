# 0014. macOS Code Signing & Notarization

**Status**: accepted
**Date**: 2026-06-24

## Problem Statement

[ADR 0011](0011-cli-release-and-distribution-strategy.md) decided to ship the TypeScript CLI **unsigned**, matching the Go CLI, with macOS notarization listed as *contingent follow-up A* — to be activated only if validation showed Bun single-file executables (SFEs) were rejected by Gatekeeper/AMFI in a way the Go binaries were not.

**That trigger has fired.** On macOS 26/27, the released CLI is `SIGKILL`ed at launch ([CLI-1621](https://linear.app/supabase/issue/CLI-1621), [GitHub #5556](https://github.com/supabase/cli/issues/5556)). Inspecting the shipped `darwin-arm64` artifacts shows the cause: both the Bun SFE (`supabase`) and the Go sidecar (`supabase-go`) carry only a **linker-signed ad-hoc signature** — CodeDirectory flags `CS_ADHOC | CS_LINKER_SIGNED` (`0x20002`), identifier `a.out`, a single CodeDirectory blob, no RequirementSet, no CMS slot. This is the minimal signature a linker emits so an arm64 binary can load at all; macOS 26+ AMFI now refuses to execute it. Affected users confirmed that re-signing in place with `codesign --force -s -` fixes it — i.e. replacing the linker stub with a **full ad-hoc signature**.

This is not unique to one install method: every channel (npm platform packages, Homebrew, GitHub Release tarballs → `install` script → `setup-cli`) ultimately executes the same `@supabase/cli-darwin-<arch>/bin/supabase` SFE produced by [`apps/cli/scripts/build.ts`](../../apps/cli/scripts/build.ts).

## Decision

Sign the macOS binaries **in the build pipeline**, on the existing Linux build runner, using [`rcodesign`](https://github.com/indygreg/apple-platform-rs) (the apple-codesign project). Because every channel consumes the same `packages/cli-darwin-*/bin/` binaries, signing once — between compilation and archiving in `build.ts` — covers all of them.

Roll out in two phases:

| Phase | What | Secrets | Status |
| --- | --- | --- | --- |
| **1 — Full ad-hoc** | Replace the linker-signed signature with a complete ad-hoc signature (CodeDirectory + RequirementSet + empty CMS), the same shape `codesign --sign -` produces. Fixes the SIGKILL. | **None** | **Implemented** |
| **2 — Developer ID + notarization** | Sign with an Apple Developer ID certificate + hardened runtime + entitlements + secure timestamp, then notarize via the App Store Connect API. | Apple cert + API key | Deferred (ops-gated) |

| Concern | Choice |
| --- | --- |
| Signing tool | **`rcodesign`** — signs Mach-O from Linux; no macOS signing host, no pipeline split |
| Where | Inside [`build.ts`](../../apps/cli/scripts/build.ts), after compile, before archive/checksums |
| Binaries | `supabase` (always) and `supabase-go` (legacy shell), for `darwin-arm64` + `darwin-x64` |
| Identifiers | `com.supabase.cli` (SFE), `com.supabase.cli-go` (sidecar) |
| CI enforcement | `SUPABASE_CLI_REQUIRE_SIGNING=1` hard-fails the build if `rcodesign` is missing; local builds warn and skip |
| Verification | macOS smoke-test runners (`macos-latest`, `macos-15-intel`): `codesign --verify --strict`, identifier check, not-linker-signed check, and actually running `supabase --version` (the real AMFI gate) |
| Validation gate | A staged `dry_run` release must show the macOS smoke legs green before any real cut — see [release-process.md § Code signing](../../apps/cli/docs/release-process.md#code-signing-macos) |

This supersedes only the **"Artifact signing"** row and **contingent follow-up A** of ADR 0011. The rest of ADR 0011 (Bun SFE packaging, npm `optionalDependencies`, nfpm, channel layout) is unchanged.

## Rationale

### Why ad-hoc fixes it without an Apple account

There are three signature levels, not two: (1) **linker-signed ad-hoc** — the degenerate stub macOS 26+ rejects; (2) **full ad-hoc** (`codesign -s -`) — a complete, well-formed self-signature with no Apple *identity*; (3) **Developer ID + notarized**. The SIGKILL is caused by (1). Upgrading to (2) is sufficient because the channels that matter (Homebrew, npm, Scoop) fetch binaries without attaching the `com.apple.quarantine` xattr, so Gatekeeper never demands notarization — it only requires a *valid* signature, which a full ad-hoc signature is. This was confirmed empirically: re-signing the actual released binary with `rcodesign sign` turned `flags: ADHOC | LINKER_SIGNED` / `identifier: a.out` / 1 blob into `flags: ADHOC` / `identifier: com.supabase.cli` / 3 blobs (CodeDirectory + RequirementSet + CMS) — byte-shape identical to `codesign -s -`.

### Why sign on Linux (no macOS job)

Code signing is appending a well-formed data structure to the Mach-O — a pure format/crypto operation that does not require the macOS kernel or Apple's tooling. `rcodesign` reimplements it and runs anywhere; it also performs Developer ID signing (`--p12-file`) and notarization (`notary-submit` against the App Store Connect API) from Linux. Keeping signing inside the single existing Linux build job avoids splitting the pipeline, shuttling artifacts to a macOS runner, and re-deriving archives/checksums. The macOS runners we already pay for are used for what genuinely needs a Mac: **verifying** the signature works.

### Phase 2 specifics (when activated)

- **Entitlements** (Bun SFE only; the Go sidecar gets plain hardened-runtime signing): `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory` — verify the exact list against [Bun's code-signing docs](https://bun.com/docs/bundler/executables#code-signing-on-macos) at implementation time.
- **Secrets**: `APPLE_CODESIGN_P12_BASE64`, `APPLE_CODESIGN_P12_PASSWORD`, `APPLE_APP_STORE_CONNECT_API_KEY_JSON`. Provided only to the build job; **not** passed to PR-triggered preview builds.
- **No stapling**: a bare Mach-O executable cannot be stapled; Gatekeeper fetches the notarization ticket online. This is fine for the direct-download path on a networked machine; offline first-run of a quarantined download falls back to signature validation.
- **Failure policy**: a notarization `Invalid`/timeout **fails the build job**. It runs before smoke-test/publish, so nothing user-visible is published on failure.

## Consequences

### Positive

- Fixes the macOS 26+ launch SIGKILL across every distribution channel from a single signing point.
- Phase 1 ships immediately — no Apple Developer account, certificate, or CI secret required.
- One toolchain, one runner: signing stays inside the existing Linux build job.
- Forward-compatible: the same `build.ts` hook and the mode-detecting smoke-test verifier extend to Developer ID + notarization in Phase 2 with no restructuring.

### Negative / trade-offs

- **Ad-hoc ≠ notarized.** A quarantined direct download (`curl`/browser of the GitHub Release `.tar.gz`/`.zip`) can still be blocked by Gatekeeper until Phase 2. Homebrew/npm/Scoop are unaffected.
- **rcodesign vs codesign equivalence is validated, not assumed.** An `rcodesign`-produced ad-hoc signature is structurally identical to `codesign`'s, but the authoritative check is macOS itself — hence the macOS smoke-test leg runs the binary, and a staged `dry_run` is a required gate before each production cut.
- **New pinned tool dependency.** `rcodesign` is downloaded (pinned version + sha256) from GitHub releases in CI, like `nfpm`.

## Follow-ups (not implemented here)

- **Phase 2 (Developer ID + notarization)** — activate once Apple credentials are provisioned (see table above).
- **Windows Authenticode** (ADR 0011 follow-up B) — Azure Trusted Signing via `jsign` (signs PE from Linux), same `build.ts` hook for `bun-windows-*` targets before zipping. Trigger: SmartScreen pressure.
- **Linux/archive `cosign`** (ADR 0011 follow-up C) — keyless `cosign sign-blob` over `dist/checksums.txt` with GitHub OIDC; gated on demand.

## Related Decisions

- [ADR 0011](0011-cli-release-and-distribution-strategy.md) — CLI Release & Distribution Strategy. This ADR supersedes its "Artifact signing" decision and contingent follow-up A.

## See Also

- [`apps/cli/docs/release-process.md` § Code signing (macOS)](../../apps/cli/docs/release-process.md#code-signing-macos) — operational gate and dry-run validation.
- [`apps/cli/scripts/build.ts`](../../apps/cli/scripts/build.ts) — `resolveSignMode()` + `signDarwinBinaries()`.
- [`.github/workflows/build-cli-artifacts.yml`](../../.github/workflows/build-cli-artifacts.yml) — pinned `rcodesign` install + signature verification.
- [`apps/cli/tests/helpers/macos-signature.ts`](../../apps/cli/tests/helpers/macos-signature.ts) — macOS smoke-test signature verifier.
