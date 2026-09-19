# 0026. Slim image and native artifact mirrors

**Status**: proposed
**Date**: 2026-09-17

## Problem Statement

Slim service images publish to `ghcr.io/supabase/cli/<service>:<version>`. Native archives publish to GitHub Releases. A broken build must be replaceable under the **same** upstream version string (`force=true`); bumping the tag is not an option.

Some agent sandboxes block GitHub release-asset downloads for repositories that are not attached to the session, and they allow registry **front** hosts while blocking the **blob CDNs** those registries redirect to. A single download URL cannot serve every sandbox.

## Decision

Publish each slim **image** to GHCR and AWS ECR Public (`public.ecr.aws/supabase/cli/<service>`), digest-preserving. Publish each slim **native** archive as an OCI artifact on the same two repositories under `:version-native-<target>` (not `:version-linux-*`, which are image platform tags). GitHub Releases remain the human HTTPS copy and `--clobber` on force.

The CLI tries an ordered candidate list. Well-known environment markers (`CLAUDE_CODE_REMOTE` / `CLAUDECODE` / `CLAUDE_CODE`, `CODEX_SANDBOX` / `CODEX_THREAD_ID` / `CODEX_CI`, `CURSOR_AGENT`) reorder that list; a failed host falls through. `SUPABASE_INTERNAL_IMAGE_REGISTRY` remains a hard override. Image rewrites are host-prefix swaps and keep `@sha256` when present ([ADR 0017](0017-simplified-managed-stack-architecture.md) digest pins). Stack catalog pulls (`RuntimeArtifacts` / `ContainerRuntime`) use the same candidates as the Docker image helper. Native OCI pulls use the registry bearer-token dance.

`force=true` always requests the ECR copy, including when the image digest is unchanged (natives may have moved). The **image** destination digest gates `publish-release` once the dispatch token exists. Native ECR copy is best-effort and must not fail that release. Catalog sync consumes the image `service` / `version` / `digest` only; native tags ride in a separate payload field. Do not prune untagged GHCR or ECR manifests: already-shipped CLIs still pin old image digests until a catalog PR ships. Natives follow the moved tag immediately.

ECR Public tags are always mutable; `ecr-public create-repository` has no immutability flag. Reuse the existing `PROD_AWS_ROLE` in `supabase/cli`. Do not add a public S3 bucket or a second cloud vendor for this cut.

## Follow-up

Claude Trusted lists `public.ecr.aws` and `ghcr.io` but 403s blob CDNs (`*.cloudfront.net`, `pkg-containers.githubusercontent.com`) and GitHub release assets for unattached repos ([claude-code#71629](https://github.com/anthropics/claude-code/issues/71629)). Later options: S3 HTTPS on `*.amazonaws.com`, or Anthropic adding blob hosts.

## Rationale

ECR Public mirroring already exists for other CLI images and needs no new vendor. Native OCI on those same repos reuses `regctl` and that role. Environment-aware order is required because some failures are mid-pull (manifest succeeds, blob CDN is denied), not a cheap connect miss.

## Consequences

- Same-version overwrite works on GHCR, GitHub Releases, and ECR Public.
- Sandboxes whose blob CDNs are not allowlisted still cannot finish an ECR or GHCR layer download until that allowlist changes or a later HTTPS host on an allowed name (for example S3 on `*.amazonaws.com`) is added.
- A GitHub native can be live while the ECR native is stale; daily mirror audit must report native drift.
- Old CLI releases keep pulling the previous image digest.

## Alternatives considered

1. **Google Artifact Registry / GCS** — blob host `storage.googleapis.com` is on at least one major sandbox Trusted list. Rejected for this cut: new company-wide vendor.
2. **Public S3 bucket** — HTTPS GET on `*.amazonaws.com` can work without CloudFront. Rejected for this cut: new public bucket, IAM, and security review on `PROD_AWS_ROLE`.
3. **npm packages** — allowlisted widely, but a published version cannot be replaced.
4. **Docker Hub `supabase/cli-*`** — deferred; blob CDN is also off some default allowlists, and names collide with upstream `supabase/<service>`.
5. **Unpin slim images** — would make old CLIs see a moved tag. Rejected: conflicts with ADR 0017.

## Related

- [ADR 0011](0011-cli-release-and-distribution-strategy.md) — CLI binary distribution (npm + GitHub Releases)
- [ADR 0017](0017-simplified-managed-stack-architecture.md) — catalog digest pins
- slim-services `docs/design/ecr-mirror-dispatch.md` — dispatch contract
