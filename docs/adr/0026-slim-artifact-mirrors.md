# 0026. Slim image and native artifact mirrors

**Status**: accepted
**Date**: 2026-09-29

## Problem Statement

slim-services used to publish each artifact under the exact upstream version string, so the
only way to fix bad packaging was `force=true`: overwrite the GitHub release assets
(`--clobber`), move the GHCR/ECR tags, and overwrite the S3 objects. That broke already-released
CLIs pinned to that version, and the CLI itself resolved artifacts inconsistently: some catalog
images were pinned by `@sha256` and some were tag-only, native archives had no pin at all, and
`manifest.json` was not integrity-checked despite supplying `entrypoint`/`cmd`. The runtime
checksum came from mutable sources — the release `SHA256SUMS` or a GHCR `:<v>-native-<target>`
tag — so one CLI version could run different bytes on different machines.

Some consumers also cannot reach GitHub release assets or a single registry blob CDN. This ADR
covers the immutable publish scheme, the CLI's content pins, and the local stack's fail-through
across mirrors.

## Decision

### Immutable revisions

Every slim-services publish carries a release version `R = <U>-r<N>`, where `U` is the upstream
tag exactly as the service's `tag_pattern` matches it and `N` is a revision starting at `0`.
Revision `N` of `U` is taken exactly when the GitHub release `<svc>-U-rN` exists — the GitHub
release is the commit point. Allocation is `max(taken) + 1`, computed from the full paginated
release list before any push. Once a release exists, `gh release create` is create-only: nothing
ever writes to that `-rN` again, so **there is no same-version overwrite**. A hotfix publishes a
new `-rN`; it never touches a previously published revision's bytes. `R` is never fed to a
semver library — ordering is the service's upstream version key, then revision, numerically.

**Legacy tags** (without `-rN`) are frozen: nothing parses, audits, rewrites, or unpublishes
them, so CLIs pinned to a legacy tag keep working.

### The catalog is the single version table

The CLI's stack catalog (`packages/stack/src/Artifacts.ts`) is the single version table for
every consumer of a slim-capable service: the new stack, legacy `supabase start`, and legacy
slim mode. Each slim-capable service pins exactly one committed slim-services release per
release line it carries (`ArtifactPin`, keyed by upstream version; only postgres carries more
than one line, its default plus additional Postgres 15 and OrioleDB pins). Everything else is derived from
that pin — never the other way around.

`apps/cli/src/shared/services/Dockerfile`, and its byte-identical Go copy
(`apps/cli-go/pkg/config/templates/Dockerfile`), keep every existing consumer (the legacy TS
stack, the Go CLI embed, `mirror-template-images.yml`, `detect-unmirrored-images.ts`) unchanged,
but for a slim-capable alias its `FROM` line is now a **generated view** of the catalog's
`ArtifactPin.upstreamImage`: `apps/cli/scripts/render-service-dockerfile.ts` rewrites those lines
in place, and a CI check (`render-service-dockerfile.unit.test.ts`) fails on drift between the
Dockerfile and the catalog. Kong and Postgres 14 have no slim build and are bumped by hand (both
share `library/kong`'s or `supabase/postgres`'s Dependabot `ignore` entry — see "Tradeoffs" below).
The one-shot job images (migra, pg_prove, pgadmin-schema-diff) also have no slim build, but are
upstream-only: they are the images Dependabot still bumps.

### Content pins, not runtime checksums

Every `ArtifactPin` pins its release by content:

- the slim image, as `ghcr.io/supabase/cli/<service>:<R>@sha256:<digest>`;
- each target's archive sha256 and manifest sha256 (`ArtifactPin.natives`);
- `upstreamImage`, the exact upstream image the release was built or mirrored from, normalized to
  the Dockerfile's `FROM` form — this is what legacy non-slim mode resolves against, and what the
  generator reads to render the Dockerfile.

`SlimServicesSource` hash-checks the manifest against its pin before parsing it (its `version`
field must equal `R`) and hash-checks the archive against its pin while it streams. There is no
runtime checksum authority: **GitHub Releases, the S3 mirror, GHCR, and ECR Public are byte
mirrors only** for both images and native archives. None of them is consulted for the expected
hash — that comes only from the pin already committed to the catalog.

### Invocations

`.github/scripts/sync-artifacts-catalog.ts` has three modes:

- **Manual** — `--service <svc> [--upstream <U> | --release <U>-r<N>]`. Refreshes one catalog
  entry; see "Sync and the S3-staleness check" below.
- **`plan-updates --service <svc> --output <path> [--format lines] [--expect-release <U>-r<N>]`**
  — used by `slim-release-published.yml`. Runs `planSlimUpdates` (see "Hotfix and upgrade pickup"
  below) against the service's committed releases and writes the resulting records only to
  `--output`, never to stdout; any `::warning ::…` the planner emits goes to stdout instead, so
  the workflow can read warnings there without risking mistaking one for a malformed record.
  `--expect-release` guards against the releases API lagging behind the dispatch that triggered
  this run (`waitForExpectedRelease`): before planning, `<service>-<release>` must already be a
  listed tag, or this mode re-lists a bounded number of times before giving up.
- **`validate-payload --service <svc> --upstream <U> --revision <N> --release <R>`** — used by the
  same workflow, before anything else. Checks an untrusted dispatch payload against anchored
  charsets and prints it back as `key=value` lines, so a value that fails validation never reaches
  `$GITHUB_OUTPUT`.

### Sync and the S3-staleness check

`.github/scripts/sync-artifacts-catalog.ts` writes those pins, in manual mode: given a service
and either `--upstream` (the highest committed revision of that upstream version) or `--release`
(exactly that committed `<upstream>-r<N>`, never "highest at apply time"), it reads the target
release's `SHA256SUMS` for the archive and manifest sha256 per target, and resolves the image
digest with `regctl manifest head`. Before writing the pin, it downloads each target's S3 archive
and manifest and hashes them against those same release sums. This exists because
`publish-release` does not wait for the ECR/S3 mirror to finish, so a freshly committed
revision's S3 copy can briefly lag. A missing object is waited for, bounded; an object that
exists with the wrong bytes fails the sync immediately — that's corruption, not lag, and means
"run the mirror backfill", not "the CLI is broken". Hosts that reach GitHub are unaffected —
GitHub is the primary mirror — but a host that can only reach S3 would otherwise fail
verification with no fallback.

### Hotfix and upgrade pickup

The last step of slim-services' `publish-release` sends a `repository_dispatch`
(`slim-release-published`) to the CLI repo with `{service, upstream_version, revision,
release_version}`. The payload arrives with whatever authority holds the dispatch token, so
`slim-release-published.yml` treats it as untrusted: `validate-payload` mode checks every field
against an anchored charset before it is written to `$GITHUB_OUTPUT`, a branch name, or a PR
title, and the workflow only ever passes those fields through `env:`, never interpolating them
into a `run:` script. Release tag names come from the releases API too, so `planSlimUpdates`
re-validates every value it emits against the same patterns before it can reach a branch name or
PR title.

The workflow treats the dispatch as a trigger, not as the payload to apply: it reconciles the
named service against every committed (published, non-draft) `<service>-...-r<N>` release it can
currently see (`planSlimUpdates`), and opens or updates, per release line the service carries, at
most one of:

- a **hotfix**, when the pinned upstream version has a higher committed revision — branch
  `slim-hotfix/<svc>[-<line>]`, title `chore(stack): pin <svc> <release_version>`;
- an **upgrade**, when the newest committed upstream on that line is newer than the pinned one —
  branch `slim-bump/<svc>[-<line>]`, title `chore(stack): bump <svc> to <release_version>`.

A line that upgrades skips its hotfix. Both PRs would edit the same catalog span, so once the
upgrade merged, the `slim-hotfix/<svc>[-<line>]` PR would be left conflicting, and no later run
revisits it because the pin has moved past that upstream. The planner instead emits a
`::warning ::…` naming the skipped release and the manual `--release` invocation that pins it
alone. Different lines stay independent, so one run can still plan both kinds: postgres can
upgrade its 17 line while hotfixing its 15 line.

The skip lasts as long as the upgrade is available: while its PR stays open, or if it is
declined, every run skips the line's hotfix again, and only the manual `--release` invocation
pins it. A hotfix PR opened before the upgrade appeared is left as is. Merge it before the
upgrade and the upgrade PR conflicts until the next run for that service rewrites it; merge the
upgrade first and the hotfix PR is superseded and must be closed by hand.

A service with a single pin and no engine variants has a single line, which accepts any comparable
newer upstream: a Studio year rollover or a postgrest major bump moves that line forward. Only
postgres, which has additional pins and engine variants, assigns each release tag to a line by its
leading version component plus any engine-variant suffix, even when the catalog carries one pin: postgres `17.11.0.002-orioledb` is on line `17-orioledb`, separate
from stock `17`, and compares within it without the suffix. The first release of a variant line
whose stock major the catalog carries is an **add** (branch `slim-bump/<svc>-<line>`, title
`chore(stack): add <svc> <release_version>`) that inserts the line's pin; later releases hotfix or
upgrade it like any other line. Any other tag on no carried line, or with a version that isn't
comparable, is warned about and ignored rather than failing the run. Comparison strips a trailing `-sha-<hex>`, so two Studio builds dated
the same day compare equal and never produce an upgrade; the manual `--release` path pins such a
build.

Plan and apply run from the same checkout of the default branch in one job, so a re-run always
recomputes from the latest develop: a stale plan can never be applied, and a superseded PR's branch
is rewritten (force-pushed) in place rather than raced by a new one — a superseded PR is never
auto-closed. A backlog republish of an older upstream version naturally plans nothing. A branch
whose PR is in the merge queue rejects the force-push; the run waits up to 30 minutes (less when
earlier work leaves the app token too little lifetime) for the queue to merge or drop that PR, then
re-sends the same dispatch and stops, so a fresh run re-plans every remaining update from the
updated default branch. At most three re-sends run in a row. The concurrency group keeps every
pending run (`queue: max`), so a replay never cancels a newer dispatch and its release-visibility
wait. A queue that holds the branch longer, or a failed queue lookup or dispatch, fails the run with
the manual invocation below. The fallback, if the push or PR step fails, is a documented manual `bun
.github/scripts/sync-artifacts-catalog.ts --service <svc> --release <U>-r<N>` invocation, followed
by `apps/cli/scripts/render-service-dockerfile.ts` — the release itself is already committed by
then, so a failure here means "open the pull request by hand", not "republish".

Each opened or rewritten PR is approved by `supabase-oss`, which co-owns the generated files in
`.github/CODEOWNERS` because the app cannot approve its own PR, and has auto-merge enabled, so a
green PR enters the merge queue without a human review. The approval token lives in the
`auto-approve` environment, which only deploys from the default branch, so a workflow on any other
branch cannot approve with it.

The app token (contents and pull-requests write) and the approval token never reach third-party
code or disk: `git push` takes the app token only inside an explicit URL (`PUSH_REMOTE_URL`
overrides it, so a dry run can target a local bare repository), and each `gh` call gets its token
inline. The sync script, the Dockerfile generator and the formatter all run with both unset, so a
compromised transitive dependency of any of them cannot read them.

### Registry and bucket mirrors

Publish each slim **image** to GHCR and AWS ECR Public (`public.ecr.aws/supabase/cli/<service>`),
digest-preserving, via `mirror-slim-image.yml` and `.github/scripts/mirror-slim-image.ts`.
Publish each slim **native** archive as an OCI artifact on the same two repositories under
`:R-native-<target>`. A public S3 bucket on `*.amazonaws.com`
([infra/cli-artifacts](../../infra/cli-artifacts/README.md)) holds native archives for hosts that
cannot reach GitHub Releases. The container runtime pulls a catalog image from GHCR first and
falls back to the same reference on ECR Public. A failing image fallback still reports the
primary's original error. When every native archive mirror fails to serve the pinned bytes, the
error names each mirror with its failure.

ECR Public tags are always mutable; `ecr-public create-repository` has no immutability flag.
Mirror backfills of a committed revision copy the immutable GHCR bytes by digest, so re-running
one is idempotent. Reuse the existing `PROD_AWS_ROLE` in `supabase/cli`.

## Follow-up

- Native ECR copy is best-effort; a daily mirror audit should report native drift and treat the
  committed GHCR digest as the source of truth for backfills. That audit is not defined in this
  repository yet.
- Unpublishing legacy (non-revision) artifacts is planned as a separate task; they stay published
  and frozen until then.

## Rationale

ECR Public mirroring already exists for other CLI images and needs no new vendor. Native OCI on
those same repos reuses `regctl` and that role. Making the GitHub release the single commit
point, rather than a destination-specific immutability guard on each mirror, keeps the
invariant in one place: once `<svc>-U-rN` exists, every downstream copy of it is either correct
or considered stale and backfilled — never rewritten in place.

## Consequences

- Hotfixing packaging never touches previously published bytes; it always publishes a new
  revision.
- The CLI verifies every artifact it downloads against a pin already committed to its own
  catalog — no destination is trusted to supply the expected hash at runtime.
- A same-version republish is no longer possible; every fix is a new, allocatable revision.
- A revision's ECR/S3 copy can briefly lag GitHub after publish; the sync's S3-staleness check
  and the mirror backfill are what keep them converging.
- Old CLI releases keep pulling their originally pinned image digest and native bytes forever.

### Tradeoffs of moving updates onto the catalog

- Upstream and security fixes for slim-capable images now reach the CLI only once
  slim-services publishes a release. Direct Dependabot discovery is gone for them; Dependabot's
  `docker` ecosystem `ignore` list (`.github/dependabot.yml`) now excludes every slim-capable
  image plus `library/kong` and `supabase/postgres`, so it bumps only the three images that
  remain genuinely upstream-only: migra, pg_prove, pgadmin-schema-diff.
- Dependabot's 7-day cooldown no longer governs the excluded images — hotfix and upgrade PRs for
  slim-capable ones land as soon as `slim-release-published` fires, on whatever cadence
  slim-services publishes; kong and `pg14` are simply bumped by hand.
- `pg14` has no slim build and was already upstream-only; it is bumped by hand alongside kong,
  not by Dependabot — Dependabot's `docker` ecosystem ignores `supabase/postgres` entirely now,
  since it cannot tell `pg14`'s `FROM` line apart from `pg`'s and `pg15`'s by repository name
  alone.
- The Deno 1 edge-runtime override (`apps/cli/src/shared/functions/functions.shared.ts`, and the
  Go `deno1` constant) stays a separately pinned, upstream-only exception — it never goes through
  the catalog.

## Alternatives considered

1. **Google Artifact Registry / GCS** — blob host `storage.googleapis.com` is on at least one
   major sandbox Trusted list. Rejected for this cut: new company-wide vendor.
2. **Public S3 bucket** — HTTPS GET on `*.amazonaws.com` can work without CloudFront. Adopted for
   native archives, as a byte mirror only; the CLI's checksum authority is its own catalog pin,
   verified against the release's `SHA256SUMS` once at sync time, not read at runtime.
3. **npm packages** — allowlisted widely, but a published version cannot be replaced.
4. **Docker Hub `supabase/cli-*`** — deferred; blob CDN is also off some default allowlists, and
   names collide with upstream `supabase/<service>`.
5. **Same-version overwrite (`force=true` clobber)** — the original model. Rejected: it broke
   already-released CLIs pinned to that version and made a republish silently move bytes out
   from under them. Replaced by immutable `-rN` revisions.
6. **A destination-specific immutability guard (for example, an S3 conditional write)** —
   rejected in favor of making the GitHub release the single commit point; every other
   destination is just a copy that either matches it or is stale.

## Related

- [ADR 0011](0011-cli-release-and-distribution-strategy.md) — CLI binary distribution (npm + GitHub Releases)
- [ADR 0017](0017-simplified-managed-stack-architecture.md) — catalog digest pins
- slim-services `docs/design/ecr-mirror-dispatch.md` — dispatch contract
