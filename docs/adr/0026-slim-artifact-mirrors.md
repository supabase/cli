# 0026. Slim image and native artifact mirrors

**Status**: proposed
**Date**: 2026-09-17

## Problem Statement

Slim service images publish to `ghcr.io/supabase/cli/<service>:<version>`. Native archives publish to GitHub Releases. A broken build must be replaceable under the **same** upstream version string (`force=true`); bumping the tag is not an option.

Some consumers cannot reach GitHub release assets or a single registry blob CDN. Publishing one digest to more than one host is the prerequisite for later client fail-through; this ADR covers the publish path only.

## Decision

Publish each slim **image** to GHCR and AWS ECR Public (`public.ecr.aws/supabase/cli/<service>`), digest-preserving, via `mirror-slim-image.yml` and `.github/scripts/mirror-slim-image.ts`. Publish each slim **native** archive as an OCI artifact on the same two repositories under `:version-native-<target>` (not `:version-linux-*`, which are image platform tags). GitHub Releases remain the human HTTPS copy and `--clobber` on force.

`force=true` always requests the ECR copy, including when the image digest is unchanged (natives may have moved). The **image** destination digest gates `publish-release` once the dispatch token exists. Native ECR copy is best-effort (`continue-on-error`) and must not fail that release. Catalog sync consumes the image `service` / `version` / `digest` only; native tags ride in a separate `natives[]` payload field. Do not prune untagged GHCR or ECR manifests: already-shipped CLIs still pin old image digests until a catalog PR ships. Natives follow the moved tag immediately.

ECR Public tags are always mutable; `ecr-public create-repository` has no immutability flag. Reuse the existing `PROD_AWS_ROLE` in `supabase/cli`.

The two decisions below are superseded by the Follow-up, which is the behavior this repository now ships:

- A public S3 bucket on `*.amazonaws.com` holds native archives for hosts that cannot reach GitHub Releases. It is not a checksum authority.
- The stack falls through to that bucket for natives and to ECR Public for images. A fallback that also fails still reports the primary's original error.

## Follow-up

- Consume the mirrored image tags and `:version-native-<target>` artifacts from the CLI and local stack, with host-aware order and digest pins preserved ([ADR 0017](0017-simplified-managed-stack-architecture.md)).
- Claude Trusted lists `public.ecr.aws` and `ghcr.io` but 403s blob CDNs (`*.cloudfront.net`, `pkg-containers.githubusercontent.com`) and GitHub release assets for unattached repos ([claude-code#71629](https://github.com/anthropics/claude-code/issues/71629)). Natives are therefore also copied to a public S3 bucket on `*.amazonaws.com` ([infra/cli-artifacts](../../infra/cli-artifacts/README.md)), independently of the ECR copy. The local stack tries the GitHub Release first and falls back to that bucket. The expected checksum comes from the release `SHA256SUMS` or, when that is blocked, from the archive layer of the `:version-native-<target>` artifact on GHCR; the bucket is never a checksum authority, and an archive from either host is only accepted when it matches.
- The container runtime pulls a catalog image from GHCR first and falls back to the same reference on ECR Public. For images and natives alike, a failing fallback reports the primary's original error, so the mirrors only change behavior when they rescue a failed download.
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
2. **Public S3 bucket** — HTTPS GET on `*.amazonaws.com` can work without CloudFront. Superseded by the Follow-up for native archives only. The bucket is not a checksum authority, and image pulls stay on GHCR and ECR Public.
3. **npm packages** — allowlisted widely, but a published version cannot be replaced.
4. **Docker Hub `supabase/cli-*`** — deferred; blob CDN is also off some default allowlists, and names collide with upstream `supabase/<service>`.
5. **Unpin slim images** — would make old CLIs see a moved tag. Rejected: conflicts with ADR 0017.

## Related

- [ADR 0011](0011-cli-release-and-distribution-strategy.md) — CLI binary distribution (npm + GitHub Releases)
- [ADR 0017](0017-simplified-managed-stack-architecture.md) — catalog digest pins
- slim-services `docs/design/ecr-mirror-dispatch.md` — dispatch contract
