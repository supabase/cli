# 0025. Go CLI Removal

**Status**: accepted
**Date**: 2026-09-14

## Problem Statement

ADR 0016 described a residual Go delegation surface in `src/legacy/`: a handful of commands still
proxying to the Go binary (`GoProxy`) while the rest of the CLI had already been natively ported to
TypeScript. That surface has now been fully replaced natively (CLI-2432) — no command in the
TypeScript CLI spawns `supabase-go` anymore.

That leaves `apps/cli-go/` — roughly 300 tracked files across three Go modules (the root CLI
module, the `fsevents` helper module, and the separately-tagged `pkg` module) — serving nothing.
It still carries its own Go toolchain pin, CI (test/coverage/lint/CodeQL), Dependabot ecosystem,
release packaging (a second binary per platform, signed and archived alongside the TS binary), and
documentation, all to build and ship a binary nothing calls.

## Decision

Delete `apps/cli-go/` entirely. The CLI ships as a single compiled binary per platform
(`packages/cli-<platform>/bin/supabase`), built by `apps/cli/scripts/build.ts` with no Go
compilation step.

The one file the Go tree owned that TypeScript still needed — the service-image Dockerfile
manifest parsed by `dockerfileServiceImages` — was already relocated into the TS tree
(`apps/cli/src/shared/services/Dockerfile`) by a prep commit on this branch before the tree was
deleted, so no runtime behavior depends on `apps/cli-go/` by the time it's removed.

The tree's own `pkg` module (`github.com/supabase/cli/pkg`, a separately-tagged, externally
published Go module) already had a structurally broken publish path before this ADR, not merely
one this ADR chooses not to continue. At `pkg/v1.2.3` (2026-04-16, `ae7642d508`) the module lived
at repo-root `pkg/`, matching Go's subdirectory-module convention that a `pkg/vX.Y.Z` tag resolves
by finding `pkg/go.mod` at the repository root. `cad095718` ("chore(monorepo): move CLI sources
under apps/cli-go/", 2026-05-06) relocated it to `apps/cli-go/pkg/` while keeping the same module
path, so from that point any new `pkg/vX` tag would have been unresolvable — the module path no
longer matched where `go.mod` actually lived. `pkg/v1.2.3` is therefore the last resolvable
version, and was already roughly five months stale relative to `apps/cli-go/pkg`'s actual content
before this deletion. Deleting the tree makes that unresolvability permanent rather than causing
it. The durability guarantee for existing importers rests on two things: `refs/tags/pkg/v*` is
protected against deletion, creation, and force-push by a repository ruleset ("Protect pkg/v*
release tags", id 23327496), and on top of that the Go module proxy (`proxy.golang.org`, the
default `GOPROXY`) caches published module zips independently of this repository's current tree,
so an importer already pinned to a version keeps resolving it through the proxy even without
direct access to the tag.

## Consequences

### Positive

- The repo ships zero Go: no toolchain pin, no CI surface, no packaging step, no documentation
  drift between two implementations of the same CLI.
- Release archives, install scripts, and the Homebrew formula carry one binary instead of two,
  removing an entire class of "sidecar present but stale/missing" failure mode.
- `cli-go-ci.yml`'s test/coverage/lint/codegen jobs, the per-PR Go module dependency cache in the
  shared setup action, and Dependabot's `gomod` ecosystem entry are all gone — but these jobs were
  path-filtered to `apps/cli-go/**` and so ran only on PRs that touched the Go tree already; most
  ordinary PRs never paid this cost. CodeQL's shape changes rather than shrinking uniformly: its
  `go` language matrix entry is gone entirely, including from the `merge_group` trigger it used to
  run on, while the remaining `javascript-typescript` entry now runs on every `pull_request` push
  — coverage it effectively never had before, since `merge_group` was CodeQL's only unfiltered
  trigger — bounded by a new concurrency group so pushes to the same PR no longer queue up
  uncancelled analysis runs.

### Negative

- No further `pkg` module releases. External importers pinned to existing tags are unaffected, but
  anyone needing content newer than `pkg/v1.2.3` has no upgrade path within this module. Two
  external importers are known from a code-search during planning: `supabase/terraform-provider-supabase`
  (same org, pins `pkg v1.2.3`) and `turbot/steampipe-plugin-supabase` (third-party); both import
  only `pkg/api`. Because `pkg/api` is pure `oapi-codegen` output, the concrete unblock for both is
  to run `oapi-codegen` in the consuming repo against the Management API OpenAPI document —
  the same one `packages/api` already consumes — and drop the dependency on
  `github.com/supabase/cli/pkg` entirely. One caveat: the deleted `apps/cli-go/api/README.md`
  documented the Go snapshot as generated from **staging** (`https://api.supabase.green/api/v1-yaml`),
  while `packages/api` generates from **production** (`https://api.supabase.com`, see
  `packages/api/scripts/download-openapi.ts`), so a consumer following this unblock gets a
  different — production, not staging — surface than `pkg/api` had, which is worth knowing now
  that the source doc explaining that distinction is gone. Beyond these two, this repository has
  no visibility into other importers beyond the module proxy's own download counts, which aren't
  queried here.
- Go-specific CI ends entirely: Coveralls coverage upload (Go-side) had no TypeScript-side
  equivalent and simply stops with this PR — there is no CI-enforced coverage threshold for the
  TypeScript CLI today. This is a known gap, not something this PR fixes; it is a candidate for a
  follow-up if coverage enforcement is wanted.
- golangci-lint and the `go` CodeQL analysis both end, along with any lint/security coverage they
  provided that had no TypeScript-side equivalent (e.g. Go-specific vulnerability classes CodeQL's
  `javascript-typescript` matrix entry doesn't check for).
- The four `*.go-payload.ts` output-encoding specs (which drive `-o yaml`/`-o toml` byte-compatible
  output) become frozen, hand-maintained contracts with no live Go source left to diff against for
  drift. A prior commit on this branch already retargeted their drift test at the OpenAPI schema
  instead of Go source, so this is a note about the ongoing nature of that contract, not new work.
  `7b469f5b3` (2026-08-12, the CLI-1970 pin) is the last commit with the full pre-shrink Go source
  tree intact and remains the closest available provenance reference for that contract's origin,
  but it does not reflect `apps/cli-go/pkg/api`'s final state: that package kept regenerating via
  the API-sync workflow for roughly another month after that pin, until this PR's tree deletion.

## Alternatives Considered

1. **Keep `pkg/` alone as a standalone Go module in this repo.** Rejected — this reintroduces the
   entire Go toolchain, CI, and Dependabot surface this PR removes, to serve at most a couple of
   external consumers of a single module.
2. **Extract `pkg/` to its own separate repository before deleting it here.** Not chosen for this
   PR. Because the publish path was already structurally broken since the May 2026 monorepo move
   (see Decision), this would be a restart from the last resolvable state (`pkg/v1.2.3`), not a
   continuation of an active release cadence. The module shipped 14 packages (`api`, `cast`,
   `config`, `diff`, `fetcher`, `function`, `migration`, `parser`, `pgtest`, `pgxv5`, `queue`,
   `storage`, `vault`, plus the root module); "internal" audience is only evidenced for the two
   known importers named above, both of which use only `pkg/api` — not for the module as a whole.

## Related Decisions

- Supersedes [ADR 0016](0016-legacy-port-completion-and-go-cli-authority-scope.md), whose
  residual authority scope no longer applies now that `apps/cli-go/` is gone.
- [ADR 0011](0011-cli-release-and-distribution-strategy.md) and
  [ADR 0014](0014-macos-code-signing-and-notarization.md) remain historically accurate records of
  decisions made while the Go CLI still existed; they are not updated by this ADR.
- Linear: CLI-2432.

## See Also

- [`apps/cli/docs/binary-distribution.md`](../../apps/cli/docs/binary-distribution.md)
- [`apps/cli/docs/release-process.md`](../../apps/cli/docs/release-process.md)
