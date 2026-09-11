# Self-hosted GitHub Actions runners

Each instance registers a just-in-time runner with GitHub, takes exactly one
job, and registers again. `instances` in `supabase/config.toml` is the pool
size: one instance is one concurrent job.

## 1. Give it credentials

The runner needs permission to create runner registrations — either a token:

| Scope     | Fine-grained PAT                          | Classic PAT |
| --------- | ----------------------------------------- | ----------- |
| One repo  | Administration: Read and write            | `repo`      |
| Whole org | Self-hosted runners: Read and write (org) | `admin:org` |

…or a GitHub App with the same permissions, installed on the repo or org. An
App is the better choice for an org pool: it is not tied to a person, and each
job mints its own one-hour installation token.

Computes read project secrets as environment variables:

```sh
supabase secrets set GITHUB_OWNER=your-org GITHUB_REPO=your-repo GITHUB_PAT=…
```

Leave `GITHUB_REPO` unset for an org-level runner every repo in the org can
use. For a GitHub App, set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (PEM,
`\n`-escaped PEM, or base64-encoded PEM) instead of `GITHUB_PAT`.

Optional: `RUNNER_LABELS` (default `supabase`), `RUNNER_GROUP_ID` (default `1`,
which is "Default"; repo-level runners must use it), `RUNNER_NAME_PREFIX`,
`RUNNER_SIZE_LABEL`, and `GITHUB_API_URL` for GitHub Enterprise Server.

## 2. Deploy

```sh
supabase compute push <name>
```

The runners appear under Settings → Actions → Runners on the repo or org once
the build finishes.

## 3. Target them

```yaml
jobs:
  build:
    runs-on: [self-hosted, supabase]
```

Every runner registers `self-hosted`, `Linux`, its architecture (`X64` or
`ARM64`), a size label read from its own memory cap (`supabase-2gb`,
`supabase-4gb`), and whatever is in `RUNNER_LABELS`. A job whose labels match
no online runner queues silently for 24 hours before it fails, so keep
`supabase` on jobs that do not care about size.

## Limits

- No Docker daemon: jobs using `container:`, `services:`, or Docker-based
  actions will fail.
- Nothing persists between jobs — the workspace is wiped after each one.
- Self-hosted runners run whatever a workflow tells them to, and a job runs as
  the same user as the supervisor, with sudo. Treat the credentials above as
  readable by every workflow the pool accepts: scope the token to the minimum
  (Administration: Read and write on just the repos it serves), give each pool
  its own, and rotate it like any shared secret. Do not attach a pool to a
  public repo where forked pull requests can run against it.
