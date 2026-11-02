---
name: test-audit
description: |
  Load whenever a test is authored, changed, or reviewed. Gates new tests before they are added
  and audits existing suites for low-value, duplicated, or implementation-coupled coverage across
  the unit/integration/e2e/live tiers.
---

# Test Audit

Two modes share one value bar. Authoring gates every new or changed test at write time. Audit
sweeps existing tests, read-only until each candidate has recorded evidence. Both apply the
junk patterns and retention bar below. See [Test quality](../../../AGENTS.md#test-quality) for
tiers, naming, and flake-resistance rules this skill assumes.

## Authoring gate

Before adding any test, answer all four questions. A missing answer means don't add it yet. Apply
the same questions to review suggestions that add tests or assertions, and push back when they
protect nothing:

1. What behavior does it protect?
2. What credible regression makes it fail?
3. Why doesn't existing coverage already catch that failure?
4. Does it need a test-only production seam that only exposes internals (an export, flag, or
   wrapper)? If so, move the test to the real boundary. A controlled clock, or a budget or config
   value production also reads, is fine.

## Level rule

Each contract gets one primary test at the strongest boundary that can reach it: unit for pure
logic, integration for handlers and Effect layers, e2e for the subprocess boundary through
`runSupabase()`, live only when the command must reach the real platform or data plane. A second
level needs a distinct risk the first can't reach, not the same contract replayed. Command e2e
stays at one to three golden paths. Prefer a new row in an existing table-driven case over a
near-duplicate test.

## Junk patterns

Reject a new test, or flag an existing one, that matches any of these:

- the same contract replayed at several tiers (unit, integration, e2e, live all asserting the
  same branch)
- mocks or Effect test layers that implement the behavior being asserted, rather than standing in
  for a real collaborator
- expected values produced by the helper under test instead of an independent source
- negative controls that pass for an unrelated reason, such as a different guard rejecting input
  before the path under test ever runs
- test names that promise more than the test exercises
- real-time waits on production timeouts or backoff, such as an `it.live` case sleeping through a
  retry schedule; use a controlled clock or an injected budget instead

## Retention bar

Always keep the test that gives a public CLI behavior, config, persistence, security, platform,
or published package contract its distinct proof. Being slow or static is never a reason to delete
it; a copy at another tier asserting the same thing can still be consolidated.

## Regression tests

A bug-fix test must be shown to fail on the pre-fix code for the intended reason, then pass after
the fix. A regression test that never demonstrably failed proves the mock, not the fix.

## Audit mode

Discovery stays read-only: no edits until every candidate has recorded evidence. Before touching
anything, record for each candidate:

- what the test can actually detect
- the stronger proof that remains, or would remain, without it
- any test-only production seam its deletion would free

Then mark it in a short ledger, one evidence line per mark:

- `R` retain — names the contract and the regression it catches
- `F` fix — keep the contract, repair a weak or vacuous assertion
- `C` consolidate — names the owner absorbing it (a sibling table row, a stronger boundary suite)
- `D` delete — names the proof that remains, or that no contract exists

Report the ledger in the audit response, or in the campaign's tracking issue when there is one,
never in a PR description. Prefer a few high-confidence candidates over a large speculative sweep.
