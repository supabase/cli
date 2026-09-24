# 0026. Slim image and native artifact mirrors

**Status**: proposed
**Date**: 2026-09-17

## Problem Statement

Slim service images publish to `ghcr.io/supabase/cli/<service>:<version>`. Native archives publish to GitHub Releases. A broken build must be replaceable under the **same** upstream version string (`force=true`); bumping the tag is not an option.

Some consumers cannot reach GitHub release assets or a single registry blob CDN. This ADR covers publishing those copies and the local stack's fail-through.

## Decision

Publish each slim **image** to GHCR and AWS ECR Public (`public.ecr.aws/supabase/cli/<service>`), digest-preserving, via `mirror-slim-image.yml` and `.github/scripts/mirror-slim-image.ts`. Publish each slim **native** archive as an OCI artifact on the same two repositories under `:version-native-<target>` (not `:version-linux-*`, which are image platform tags). GitHub Releases remain the human HTTPS copy and `--clobber` on force.

`force=true` always requests the ECR copy, including when the image digest is unchanged (natives may have moved). The **image** destination digest gates `publish-release` once the dispatch token exists. Native ECR copy is best-effort (`continue-on-error`) and must not fail that release. Native tags ride in a separate `natives[]` payload field. This mirror does not open a pull request to pin `packages/stack/src/Artifacts.ts`. A Dependabot Dockerfile bump commits that catalog pin onto the same pull request, so the docker.io tag, the slim image, and the native archive stay on one version. A PostgreSQL release line that is not the Dockerfile `pg` tag, and a same-version digest republish, stay put until that Dockerfile line changes. Do not prune untagged GHCR or ECR manifests: already-shipped CLIs still pin old image digests until that pull request merges. Natives follow the moved tag immediately.

ECR Public tags are always mutable; `ecr-public create-repository` has no immutability flag. Reuse the existing `PROD_AWS_ROLE` in `supabase/cli`.

A public S3 bucket on `*.amazonaws.com` holds native archives for hosts that cannot reach GitHub Releases ([infra/cli-artifacts](../../infra/cli-artifacts/README.md)). It is not a checksum authority. The stack tries the GitHub Release first and falls back to that bucket. The expected checksum comes from the release `SHA256SUMS` or, when that is blocked, from the archive layer of the `:version-native-<target>` artifact on GHCR. An archive from either host is accepted only when it matches.

The container runtime pulls a catalog image from GHCR first and falls back to the same reference on ECR Public. A failing fallback, for an image or a native archive, still reports the primary's original error.

## Follow-up

- Native ECR copy is best-effort; a daily mirror audit should report native drift. That audit is not defined in this repository yet.

## Rationale

ECR Public mirroring already exists for other CLI images and needs no new vendor. Native OCI on those same repos reuses `regctl` and that role. Extracting the workflow into bun scripts lets the copy, digest check, and native payload validation run in CI and locally.

## Consequences

- Same-version overwrite works on GHCR, GitHub Releases, and ECR Public.
- Images come from the GHCR catalog pin with ECR Public as fallback, and natives from GitHub Releases with the S3 bucket as fallback.
- A GitHub native can be live while the ECR native is stale.
- Old CLI releases keep pulling the previous image digest.

## Alternatives considered

1. **Google Artifact Registry / GCS** — blob host `storage.googleapis.com` is on at least one major sandbox Trusted list. Rejected for this cut: new company-wide vendor.
2. **Public S3 bucket** — HTTPS GET on `*.amazonaws.com` can work without CloudFront. Adopted for native archives. The bucket is not a checksum authority, and image pulls stay on GHCR and ECR Public.
3. **npm packages** — allowlisted widely, but a published version cannot be replaced.
4. **Docker Hub `supabase/cli-*`** — deferred; blob CDN is also off some default allowlists, and names collide with upstream `supabase/<service>`.
5. **Unpin slim images** — would make old CLIs see a moved tag. Rejected: conflicts with ADR 0017.

## Related

- [ADR 0011](0011-cli-release-and-distribution-strategy.md) — CLI binary distribution (npm + GitHub Releases)
- [ADR 0017](0017-simplified-managed-stack-architecture.md) — catalog digest pins
- slim-services `docs/design/ecr-mirror-dispatch.md` — dispatch contract
