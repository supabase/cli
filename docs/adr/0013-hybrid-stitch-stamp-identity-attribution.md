# 0013. Hybrid Stitch + Stamp for Telemetry Identity Attribution

**Status**: proposed
**Date**: 2026-06-11

## Problem Statement

CLI telemetry attributes events to an anonymous device ID until the user authenticates. Linking the two identities ("stitching") originally fired `$create_alias` + `$identify` on every first-authenticated-run. In environments where `~/.supabase/` does not persist between invocations (CI runners, Docker, `npx supabase`), every run looked like a first run, producing a 730K/day `$identify` spike (vs ~15K baseline; see GROWTH-886, #5366). The emergency fix gated stitching off in those environments, which stopped the spike but orphaned all CI/Docker/npx events at the device level — no user attribution at all.

GROWTH-891 proposed "Option C": never fire `$create_alias` or `$identify` anywhere; instead stash the user UUID (from the `X-Gotrue-Id` response header) in process memory and use it as `distinct_id` on subsequent capture events ("stamping"). Zero extra events, attribution restored.

Pure Option C has a hidden cost: `$create_alias` does two jobs. It labels future events (which stamping replaces for free) **and** retroactively merges past anonymous events into the user's person profile (which stamping cannot do). On a developer laptop, a user may run the CLI anonymously for weeks before first login; pure Option C would orphan that history permanently.

## Decision

Use a hybrid of stitching and stamping, differentiated by environment:

- **Stamp everywhere.** After the first authenticated API call in a process, all subsequent capture events use the user UUID as `distinct_id` directly. No extra PostHog events.
- **Stitch only in persistent environments.** On a developer laptop's first login, additionally fire exactly one `$create_alias` (no `$identify`) to merge pre-login history, and persist the UUID to `~/.supabase/telemetry.json` so later runs start identified. In ephemeral environments (detected as `isCI || (isFirstRun && !isTTY)`), never alias and never write state.
- **The gate lives inside `StitchLogin`,** not at call sites. The function always stashes the UUID in memory; the persistent-only side effects (alias + state write) branch internally. Rationale: the previous call-site gate was added to the `OnGotrueID` hook but missed the `login` command's direct call, quietly leaking aliases from CI `supabase login --token` runs. Centralizing makes the gate unforgettable for future callers.
- **Memory wins over disk.** When the in-process UUID and the persisted `distinct_id` disagree (e.g. re-login as a different user), the in-memory value is used.
- **Logout resets the identity entirely.** Logout wipes the in-memory UUID and the persisted `distinct_id`, and **rotates the device ID**. Rotation makes cross-account contamination structurally impossible: a later login as a different account aliases a fresh device instead of one already merged into the previous user's person graph. Transient failure paths (e.g. a profile lookup error during login) only clear the identity and keep the device ID, preserving anonymous-history continuity.
- **All three identity surfaces change together:** the Go CLI (`apps/cli-go/internal/telemetry/`), the legacy TS shell (`apps/cli/src/legacy/auth/legacy-platform-api.layer.ts`), and the next TS shell (`apps/cli/src/next/commands/login/`).

## Considered Options

- **Pure Option C (no alias anywhere).** Rejected: silently abandons the retroactive history merge on persistent laptops, where it has real value and where alias volume (~7K/day post-GROWTH-890) was never the problem. The volume pathology came entirely from ephemeral environments.
- **Keep the ephemeral gate at call sites.** Rejected: already failed once — the `login` command path never received the gate that the hook path got, the exact bug shape this redesign exists to prevent.
- **Status quo (gate from #5366 only).** Functional but permanently orphans all CI/Docker/npx events. Those populations are 31–85% of CLI volume and feed dashboards (Agent-Led Growth).

## Consequences

- `isEphemeralIdentityRuntime` survives as a live branch (the ticket originally planned to delete it). Its meaning changes from volume guard to "is a stitch worth anything here?" — a false positive now silently drops a laptop user's history merge instead of saving spam, so the heuristic deserves test coverage in its own right.
- Events fired before the first authenticated call in a process remain device-scoped in ephemeral environments (typically 0–3 events per run). Accepted loss.
- The TS shells need a mutable identity slot consulted at capture time, replacing the startup-snapshot-only `runtime.distinctId`.
- `$identify` is fully retired from the stitch path on all surfaces (it survives only where person properties are genuinely set).
- `$create_alias` fires only for the **first** identity a device ever sees. Re-login (or the login command's direct stitch after the response hook already stitched) stamps and persists without re-aliasing — re-aliasing an already-merged device would attempt to merge unrelated person graphs.
- In the TS shells, the rotated device ID takes effect from the next process; capture events in the tail of the logout process itself still carry the startup device-ID snapshot. Go rotates in-process as well.
