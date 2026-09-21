# cli-artifacts

CloudFormation stack for the `cli-artifacts-prod` AWS account (declared in
`supabase/aws-org-root`). It owns the public-read S3 mirror of slim native artifacts that the
CLI downloads when registry blob CDNs or GitHub release assets are blocked, for example inside
agent sandboxes that allow `*.amazonaws.com`.

## What the stack owns

- `AWS::S3::Bucket` `supabase-cli-artifacts`: anonymous `GetObject` through the bucket policy,
  TLS required, no `ListBucket`, ACLs blocked, versioning with 30-day noncurrent expiry so a bad
  same-version overwrite can be recovered.
- `AWS::IAM::Role` `slim-artifacts-publisher`: trusts the account's GitHub OIDC provider for
  `repo:supabase/cli:ref:refs/heads/develop` only and can do nothing but `s3:PutObject` on the
  bucket's objects. The slim native mirror job in `.github/workflows/mirror-slim-image.yml`
  assumes it per release once that upload step ships.

Objects are addressed as

```
https://supabase-cli-artifacts.s3.us-east-1.amazonaws.com/<service>/<version>/<service>-<version>-<target>.tar.zst
https://supabase-cli-artifacts.s3.us-east-1.amazonaws.com/<service>/<version>/<service>-<version>-<target>.manifest.json
https://supabase-cli-artifacts.s3.us-east-1.amazonaws.com/<service>/<version>/<service>-<version>-<target>.SHA256SUMS
```

which keeps the GitHub release asset names, so the `SHA256SUMS` lines match the archive name
without rewriting.

## How it deploys

`.github/workflows/cli-artifacts-infra.yml` runs `cfn-lint` on every pull request and deploys the
stack on pushes to `develop` with the account's `github-deploy` role. Every other ref can only
assume the read-only `github-preview` role, which cannot create change sets, so pull requests do
not preview against AWS. The deploy job is skipped until the `CLI_ARTIFACTS_AWS_ACCOUNT_ID`
repository variable is set.

Two roles on purpose: `github-deploy` is account admin and only ever applies this template;
the per-release upload runs as the bucket-scoped publisher role.

## Changing the trusted branch

Redeploy with a different `TrustedSubject` parameter (for example a release branch). The
subject must be the plain `repo:<owner>/<repo>:ref:refs/heads/<branch>` form that
`supabase/cli` currently emits; repositories created or renamed after 2026-07-15 emit immutable
`owner@<id>/repo@<id>` subjects instead.
