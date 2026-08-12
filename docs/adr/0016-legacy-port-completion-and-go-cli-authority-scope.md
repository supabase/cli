# 0016. Legacy Port Completion and Go CLI Authority Scope

**Status**: proposed
**Date**: 2026-08-11

## Problem Statement

`src/legacy/` started as a from-scratch, strict 1:1 port of the Go CLI (`apps/cli-go/`): every
command began as a Phase 0 proxy to the Go binary, then moved to a native TypeScript implementation
(Phase 1+). While that was true, treating `apps/cli-go/` as the unconditional authority for anything
touching `src/legacy/` was correct — nearly every change was either wrapping a new command or
replacing its proxy, and the Go source was the only available spec for what the command should do.

That phase is essentially over. Per [`apps/cli/docs/go-cli-porting-status.md`](../../apps/cli/docs/go-cli-porting-status.md#legacy-shell-command-status),
95 of 103 legacy leaf commands (~92%) are natively ported; only 8 remain Phase 0 proxies. Most
changes landing in `src/legacy/` today are ordinary engineering on already-ported commands — bug
fixes, internal refactors, hoisting shared helpers, adding documented TS-only flags, telemetry and
observability work, tests — not porting.

`apps/cli/AGENTS.md` still reads, top to bottom, as porting-era guidance: it opens with the Phase
0/1 wrapping workflow and states unconditionally that `apps/cli-go/` is "the authoritative source"
for the legacy shell. Agents (and humans) doing net-new work keep following that instruction
literally — auditing Go source, or judging review feedback against Go parity, for changes that have
nothing to do with Go parity. This slows down unrelated work and anchors reviews to the wrong
standard.

## Decision

`apps/cli-go/` remains authoritative, and must be consulted, for exactly two situations:

1. **Working on one of the remaining wrapped commands** — either maintaining its command/flag
   definition and proxy handler (these gate which invocations reach the Go binary and must still
   match it exactly) or replacing the wrapper with a native implementation (Phase 0 → Phase 1).
2. **A change that touches an already-ported command's established parity surface** — command or
   flag names, stdout/stderr text, exit codes, all documented side effects (filesystem, database,
   Docker/subprocess, API requests — see each command's `SIDE_EFFECTS.md`), or telemetry semantics
   (which events fire, when, and their payload shape). Here, Go source is a regression check ("does
   this still match what we already shipped"), not a design source.

For everything else in `src/legacy/` — internal refactors, bug fixes that don't change the surface
above, hoisting shared helpers, adding a documented TS-only flag/feature on an already-ported
command (the pattern already established by `--skip-vault`, `--reveal`, `--high-availability`),
tests, tooling — `apps/cli-go/` is not required reading and Go behavior is not the deciding
standard. Normal engineering judgment (correctness, tests, maintainability, DX) applies, the same as
it does in `src/next/` or `src/shared/`.

`apps/cli/AGENTS.md` is updated to lead with this scope instead of assuming every reader is mid-port.

## Rationale

The cost of the blanket framing was asymmetric: it made net-new work slower and reviews harder to
reason about, without making the remaining real parity work (8 commands, plus regression risk on the
95 already ported) any safer — that work is already called out explicitly in the porting-status
tracker and doesn't need a blanket rule to be found. Scoping the authority claim to the two cases
where it actually matters keeps the real guarantee (the legacy shell does not silently regress
against Go, and the last wrapped commands still get ported) while freeing the other ~92% of the
surface from a parity check it never needed.

## Consequences

### Positive

- Net-new changes in `src/legacy/` — bug fixes, refactors, TS-only additions — no longer require
  auditing `apps/cli-go/` or justifying themselves against Go behavior that isn't in scope.
- Review feedback on such changes is judged on normal engineering merit instead of being forced
  through a parity lens that doesn't apply.
- The two cases where Go really is authoritative (the 8 still-wrapped commands, including finishing
  their ports; not regressing the 95 already-ported commands) are named explicitly instead of being
  implied by a blanket rule.

### Negative

- Contributors now have to briefly classify a change (does it touch the parity surface?) rather than
  defaulting to "always check Go." Misclassification risk is partly, not fully, mitigated:
  [`apps/cli/docs/go-cli-porting-status.md`](../../apps/cli/docs/go-cli-porting-status.md) stays the
  source of truth for which commands are still `wrapped`, and CI's `testParity` /
  `*.e2e.test.ts` suites catch output/behavior drift on the already-ported commands and code paths
  they cover — but that coverage is deliberately partial (e.g. `db pull --local` and `db lint
  --local` skip `testParity` today, see `apps/cli-e2e/src/tests/database-core.e2e.test.ts`), so a
  misclassified change on an uncovered path can still land without a human or agent ever consulting
  Go.

## Alternatives Considered

1. **Keep the blanket authority framing and rely on agents/reviewers to infer scope.** Rejected —
   this is what's failing today; the framing is read literally.
2. **Drop Go-CLI parity as a concern entirely now that the port is mostly done.** Rejected — the
   remaining 8 wrapped commands still need porting, and the whole point of `src/legacy/` is to be a
   stable-channel drop-in replacement for the Go CLI, so already-ported commands must not regress.

## Related Decisions

- None yet — this is the first ADR to describe the `legacy`/`next` split and the scope of Go CLI
  authority explicitly; prior guidance lived only in `apps/cli/AGENTS.md`.

## See Also

- [`apps/cli/AGENTS.md`](../../apps/cli/AGENTS.md)
- [`apps/cli/docs/go-cli-porting-status.md`](../../apps/cli/docs/go-cli-porting-status.md)

## Addendum (2026-08-12): CLI-1970 outcome

The residual Go surface this ADR anticipated shipped as decided: `apps/cli-go/` now contains only
the commands `LegacyGoProxy` still proxies to (the remaining `wrapped` commands, plus the
single-flag Go delegations on `db diff`, `db pull`, and `functions download`). Every other command's
Go source — everything unreachable from that surface, directly or indirectly — was deleted outright
rather than kept around unused. Commit `7b469f5b3` is the parity/provenance reference for any of that
deleted code, the same role `a253ccba2` already played for `internal/start` (CLI-1966).

The go-target e2e parity harness this ADR's Consequences section cites (`testParity`, `*.e2e.test.ts`
coverage of output/behavior drift via a `go` `CLITarget`) was retired in the same change. `runParity`
and the `go` harness target no longer exist in `packages/cli-test-helpers`; the shipped e2e suite now
exercises `ts-legacy` only, and no longer runs the Go CLI to compare its output against TypeScript's.
