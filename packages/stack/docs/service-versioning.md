# Service Versioning in the Supabase CLI

How the Go CLI (`supabase-cli-go`) manages Docker image versions for local development services, and suggestions for `@supabase/local`.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Version Resolution Flow                     │
│                                                                 │
│  Dockerfile manifest ──→ init() parsing ──→ Images struct       │
│        (source of truth)      (regex)         (defaults)        │
│                                                                 │
│  .temp/ version files ──→ config.Load() ──→ override defaults   │
│   (written by `link`)         (fsys)        (per-service)       │
│                                                                 │
│  config.toml ──→ db.major_version ──→ select pg image           │
│   (user config)                       (13/14/15/17)             │
│                                                                 │
│  INTERNAL_IMAGE_REGISTRY ──→ GetRegistryImageUrl() ──→ pull URL │
│   (env var override)           (registry prefix)                │
└─────────────────────────────────────────────────────────────────┘
```

## 1. Source of Truth: The Dockerfile Manifest

All default Docker image versions are defined in a single file:

**File:** `pkg/config/templates/Dockerfile`

```dockerfile
# Exposed for updates by .github/dependabot.yml
FROM supabase/postgres:17.6.1.090 AS pg
# Append to ServiceImages when adding new dependencies below
FROM library/kong:2.8.1 AS kong
FROM axllent/mailpit:v1.22.3 AS mailpit
FROM postgrest/postgrest:v14.5 AS postgrest
FROM supabase/postgres-meta:v0.95.2 AS pgmeta
FROM supabase/studio:2026.02.16-sha-26c615c AS studio
FROM darthsim/imgproxy:v3.8.0 AS imgproxy
FROM supabase/edge-runtime:v1.70.5 AS edgeruntime
FROM timberio/vector:0.28.1-alpine AS vector
FROM supabase/supavisor:2.7.4 AS supavisor
FROM supabase/gotrue:v2.187.0 AS gotrue
FROM supabase/realtime:v2.78.3 AS realtime
FROM supabase/storage-api:v1.39.2 AS storage
FROM supabase/logflare:1.33.3 AS logflare
# Append to JobImages when adding new dependencies below
FROM supabase/pgadmin-schema-diff:cli-0.0.5 AS differ
FROM supabase/migra:3.0.1663481299 AS migra
FROM supabase/pg_prove:3.36 AS pgprove
```

This is **not** an actual Dockerfile used to build anything. It's a clever hack that repurposes Dockerfile `FROM` syntax purely as a version manifest. The `AS` alias maps each image to a field name in the `images` Go struct.

### Why a Dockerfile?

Dependabot natively understands Dockerfile `FROM` statements and can automatically open PRs to bump image tags. By encoding versions as `FROM` lines, the CLI gets free automated version updates without custom tooling.

## 2. Version Format Inconsistencies

Services use several different version formats with no standardization:

| Format                   | Examples                 | Services                                                   |
| ------------------------ | ------------------------ | ---------------------------------------------------------- |
| `vX.Y.Z`                 | `v2.187.0`, `v1.70.5`    | gotrue, realtime, storage, imgproxy, mailpit, edge-runtime |
| `X.Y.Z`                  | `2.8.1`, `2.7.4`         | kong, supavisor                                            |
| `X.Y.Z.NNN` (4-part)     | `17.6.1.090`             | postgres (Supabase custom)                                 |
| `X.Y`                    | `v14.5`                  | postgrest                                                  |
| `YYYY.MM.DD-sha-XXXXXXX` | `2026.02.16-sha-26c615c` | studio                                                     |
| `X.Y.Z-suffix`           | `0.28.1-alpine`          | vector                                                     |
| `X.Y.TIMESTAMP`          | `3.0.1663481299`         | migra                                                      |
| `X.Y`                    | `3.36`                   | pg_prove                                                   |
| `cli-X.Y.Z`              | `cli-0.0.5`              | differ                                                     |

This means generic semver comparison doesn't work across all services. The CLI has a custom `VersionCompare()` function specifically for the 4-part Postgres format.

## 3. Parsing Mechanism

**File:** `pkg/config/constants.go`

At program initialization, the Dockerfile is embedded via `//go:embed` and parsed with a regex:

```go
var (
    //go:embed templates/Dockerfile
    dockerImage  string
    imagePattern = regexp.MustCompile(`(?i)FROM\s+([^\s]+)\s+AS\s+([^\s]+)`)
    Images       images
)

func init() {
    matches := imagePattern.FindAllStringSubmatch(dockerImage, -1)
    result := make(map[string]string, len(matches))
    for _, m := range matches {
        if len(m) == 3 {
            result[m[2]] = m[1]  // alias → image:tag
        }
    }
    if err := mapstructure.Decode(result, &Images); err != nil {
        panic(errors.Errorf("failed to decode images: %w", err))
    }
}
```

The `images` struct uses `mapstructure` tags matching the `AS` aliases:

```go
type images struct {
    Pg          string `mapstructure:"pg"`
    Kong        string `mapstructure:"kong"`
    Inbucket    string `mapstructure:"mailpit"`
    Postgrest   string `mapstructure:"postgrest"`
    Pgmeta      string `mapstructure:"pgmeta"`
    Studio      string `mapstructure:"studio"`
    ImgProxy    string `mapstructure:"imgproxy"`
    EdgeRuntime string `mapstructure:"edgeruntime"`
    Vector      string `mapstructure:"vector"`
    Supavisor   string `mapstructure:"supavisor"`
    Gotrue      string `mapstructure:"gotrue"`
    Realtime    string `mapstructure:"realtime"`
    Storage     string `mapstructure:"storage"`
    Logflare    string `mapstructure:"logflare"`
    Differ      string `mapstructure:"differ"`
    Migra       string `mapstructure:"migra"`
    PgProve     string `mapstructure:"pgprove"`
}
```

Legacy fallback constants exist for older Postgres versions:

```go
const (
    pg13  = "supabase/postgres:13.3.0"
    pg14  = "supabase/postgres:14.1.0.89"
    pg15  = "supabase/postgres:15.8.1.085"
    deno1 = "supabase/edge-runtime:v1.68.4"
)
```

## 4. Automated Version Updates (Dependabot)

**File:** `.github/dependabot.yml`

Dependabot is configured to scan the `pkg/config/templates` directory for Docker image updates:

```yaml
- package-ecosystem: "docker"
  directory: "pkg/config/templates"
  schedule:
    interval: "cron"
    cronjob: "0 0 * * *" # Daily
  commit-message:
    prefix: "fix(docker): " # Conventional commit prefix
  groups:
    docker-minor:
      update-types:
        - minor
        - patch
  ignore:
    - dependency-name: "library/kong" # Pinned — major API changes
    - dependency-name: "axllent/mailpit" # Pinned
    - dependency-name: "darthsim/imgproxy" # Pinned
    - dependency-name: "timberio/vector" # Pinned
```

Key behaviors:

- **Scope:** Only minor and patch updates are automated; major bumps require manual review
- **Ignored services:** kong, mailpit, imgproxy, and vector are excluded (likely due to breaking changes in new majors or because they're pinned to specific compatible versions)
- **Grouping:** Minor/patch updates are grouped into single PRs

## 5. Version Override System

**File:** `pkg/config/config.go` (lines 620–668) and `pkg/config/utils.go`

When a project is linked to a remote Supabase project (`supabase link`), the CLI writes version files into `.supabase/.temp/`:

```
.supabase/.temp/
├── postgres-version       # e.g., "17.6.1.090"
├── gotrue-version         # e.g., "v2.187.0"
├── rest-version           # e.g., "v14.5"
├── storage-version        # e.g., "v1.39.2"
├── edge-runtime-version   # e.g., "v1.70.5"
├── studio-version
├── pgmeta-version
├── pooler-version
├── realtime-version
└── logflare-version
```

At config load time, these files override the defaults:

```go
// Postgres: only override if version >= 15.1.0.55
if version, err := fs.ReadFile(fsys, builder.PostgresVersionPath); err == nil {
    if i := strings.IndexByte(c.Db.Image, ':'); VersionCompare(c.Db.Image[i+1:], "15.1.0.55") >= 0 {
        c.Db.Image = replaceImageTag(Images.Pg, string(version))
    }
}

// Storage: only override if linked version is NEWER (prevents downgrade)
if version, err := fs.ReadFile(fsys, builder.StorageVersionPath); err == nil && len(version) > 0 {
    if i := strings.IndexByte(Images.Storage, ':'); semver.Compare(
        strings.TrimSpace(string(version)), Images.Storage[i+1:],
    ) > 0 {
        c.Storage.Image = replaceImageTag(Images.Storage, string(version))
    }
}

// Other services: override unconditionally if file exists
if version, err := fs.ReadFile(fsys, builder.GotrueVersionPath); err == nil && len(version) > 0 {
    c.Auth.Image = replaceImageTag(Images.Gotrue, string(version))
}
```

The `replaceImageTag` helper swaps just the tag portion:

```go
func replaceImageTag(image string, tag string) string {
    index := strings.IndexByte(image, ':')
    return image[:index+1] + strings.TrimSpace(tag)
}
```

### Priority order (highest wins):

1. **Version override files** (`.temp/*-version`) — written by `supabase link`
2. **`config.toml` `db.major_version`** — selects the Postgres base image (13/14/15/17)
3. **Dockerfile defaults** — built-in versions compiled into the binary

There are no CLI flags to override individual service versions at runtime.

## 6. Registry Mirroring

**File:** `.github/workflows/mirror-image.yml`

The default pull registry is **AWS ECR Public** (`public.ecr.aws`), not Docker Hub. This avoids Docker Hub rate limits.

```go
const defaultRegistry = "public.ecr.aws"

func GetRegistryImageUrl(imageName string) string {
    registry := GetRegistry()  // checks INTERNAL_IMAGE_REGISTRY env var
    if registry == "docker.io" {
        return imageName       // use original image name as-is
    }
    // Mirror: strip org prefix, use supabase namespace
    parts := strings.Split(imageName, "/")
    imageName = parts[len(parts)-1]
    return registry + "/supabase/" + imageName
}
```

Example transformations:

- `supabase/gotrue:v2.187.0` → `public.ecr.aws/supabase/gotrue:v2.187.0`
- `library/kong:2.8.1` → `public.ecr.aws/supabase/kong:2.8.1`
- `postgrest/postgrest:v14.5` → `public.ecr.aws/supabase/postgrest:v14.5`

The mirror workflow copies images from Docker Hub to both:

- `public.ecr.aws/supabase/<image>:<tag>`
- `ghcr.io/supabase/<image>:<tag>`

Users can switch registries via the `INTERNAL_IMAGE_REGISTRY` env var (e.g., set to `docker.io` to pull from Docker Hub directly).

## 7. Version Comparison

**File:** `pkg/config/config.go` (lines 679–693)

Supabase Postgres uses a 4-part version scheme (`17.6.1.090`) that standard semver libraries can't compare. The CLI has a custom comparator:

```go
func VersionCompare(a, b string) int {
    var pA, pB string
    if vA := strings.Split(a, "."); len(vA) > 3 {
        a = strings.Join(vA[:3], ".")   // "17.6.1"
        pA = strings.TrimLeft(strings.Join(vA[3:], "."), "0")  // "90"
    }
    if vB := strings.Split(b, "."); len(vB) > 3 {
        b = strings.Join(vB[:3], ".")
        pB = strings.TrimLeft(strings.Join(vB[3:], "."), "0")
    }
    if r := semver.Compare("v"+a, "v"+b); r != 0 {
        return r
    }
    return semver.Compare("v"+pA, "v"+pB)
}
```

This splits `17.6.1.090` into base semver `17.6.1` and patch `090`, comparing each part independently. The `TrimLeft("0")` means `090` is compared as `90`.

## 8. Service Version Checking

**File:** `internal/services/services.go`

The `supabase services` command displays a table comparing local vs. linked (remote) versions:

```
|SERVICE IMAGE|LOCAL|LINKED|
|-|-|-|
|supabase/gotrue|v2.187.0|v2.185.0|
|supabase/realtime|v2.78.3|-|
...
```

When versions differ, it warns:

```
WARNING: You are running different service versions locally than your linked project.
Run `supabase link` to update them.
```

This fetches remote versions by querying the Supabase Tenant API for each service endpoint.

## 9. Complete Service Inventory

### Runtime Services (always running)

| Service       | Image                    | Current Version          | Category                   |
| ------------- | ------------------------ | ------------------------ | -------------------------- |
| PostgreSQL    | `supabase/postgres`      | `17.6.1.090`             | Database                   |
| PostgREST     | `postgrest/postgrest`    | `v14.5`                  | API                        |
| GoTrue        | `supabase/gotrue`        | `v2.187.0`               | Auth                       |
| Realtime      | `supabase/realtime`      | `v2.78.3`                | Realtime                   |
| Storage API   | `supabase/storage-api`   | `v1.39.2`                | Storage                    |
| imgproxy      | `darthsim/imgproxy`      | `v3.8.0`                 | Storage (image transforms) |
| Kong          | `library/kong`           | `2.8.1`                  | API Gateway                |
| Edge Runtime  | `supabase/edge-runtime`  | `v1.70.5`                | Functions                  |
| Studio        | `supabase/studio`        | `2026.02.16-sha-26c615c` | Dashboard                  |
| Postgres Meta | `supabase/postgres-meta` | `v0.95.2`                | Schema introspection       |
| Supavisor     | `supabase/supavisor`     | `2.7.4`                  | Connection pooling         |
| Logflare      | `supabase/logflare`      | `1.33.3`                 | Analytics                  |
| Vector        | `timberio/vector`        | `0.28.1-alpine`          | Log collection             |
| Mailpit       | `axllent/mailpit`        | `v1.22.3`                | Email (dev only)           |

### Job Images (one-off tasks)

| Service     | Image                          | Current Version  | Purpose              |
| ----------- | ------------------------------ | ---------------- | -------------------- |
| Schema Diff | `supabase/pgadmin-schema-diff` | `cli-0.0.5`      | `supabase db diff`   |
| Migra       | `supabase/migra`               | `3.0.1663481299` | Migration generation |
| pg_prove    | `supabase/pg_prove`            | `3.36`           | Database test runner |

## 10. Versioning Design for `@supabase/local`

### 10.1. Design Principles

1. **`config.toml [versions]` is the single source of truth.** No hidden `.temp/` state files. Every version choice is visible, committable, and reviewable.
2. **Version determines WHAT to run; runtime strategy determines HOW.** Whether a service runs as a native binary or Docker container is orthogonal to its version. The same version string drives both `BinaryResolver` (native) and `dockerImageForService()` (Docker fallback).
3. **CLI ships tested default versions.** A `DEFAULT_VERSIONS` constant is compiled into each CLI release — a known-good set of service versions tested together in CI.
4. **All version fields are optional.** Omitting a version in config.toml means "use the CLI's built-in default for this release." Explicit versions always win.
5. **Must work offline.** After the initial binary/image download, `supabase start` requires no network access.
6. **Dev-prod parity is paramount.** The system actively helps users keep their local stack in sync with their remote project.

### 10.2. Version Manifest

`@supabase/local` exports a typed `VersionManifest` and a `DEFAULT_VERSIONS` constant — replacing the Go CLI's Dockerfile-as-manifest hack with something transparent and type-safe:

```ts
export interface VersionManifest {
  readonly postgres: string; // e.g. "17.6.1.081-cli"
  readonly postgrest: string; // e.g. "14.5"
  readonly auth: string; // e.g. "2.187.0"
  // Future services added here as the stack grows
}

export const DEFAULT_VERSIONS: VersionManifest = {
  postgres: "17.6.1.081-cli",
  postgrest: "14.5",
  auth: "2.187.0",
} as const;
```

Version resolution happens inline in `resolveConfig()` inside `createStack.ts`, following the same `explicit ?? default` pattern:

```ts
// Inside resolveConfig()
version: postgresInput.version ?? DEFAULT_VERSIONS.postgres,
```

Each service config's `version` field is individually resolved against `DEFAULT_VERSIONS`. There is no separate `resolveVersions()` function — the resolution is embedded in the per-service config merging logic for simplicity.

A `dockerImageForService()` helper derives Docker image references from versions, eliminating the need for separate `authDockerImage` / `postgresDockerImage` fields:

```ts
function dockerImageForService(service: ServiceName, version: string): string {
  const imageMap = {
    postgres: `supabase/postgres:${version}`,
    postgrest: `postgrest/postgrest:v${version}`,
    auth: `supabase/gotrue:v${version}`,
  };
  return imageMap[service];
}
```

For automated version updates, Renovate's `regexManagers` can target the `DEFAULT_VERSIONS` constant directly — no Dockerfile indirection needed.

### 10.3. Config.toml `[versions]` Section

```toml
[versions]
# Service versions for the local development stack.
# Set automatically by `supabase link` to match your remote project.
# Set manually to pin a specific version.
# Omit to use the CLI's built-in default for this release.
#
# postgres = "17.6.1.090"
# postgrest = "14.5"
# auth = "2.187.0"
```

Resolution: `config.toml version ?? DEFAULT_VERSIONS`. Committed to VCS so the whole team uses identical versions.

### 10.4. User Stories

#### US1: Fresh start (greenfield project)

A user runs `supabase init` + `supabase start` with no remote project.

- `supabase init` generates config.toml with an empty/commented `[versions]` section
- `supabase start` calls `resolveVersions({})` → falls back to `DEFAULT_VERSIONS`
- Binaries are downloaded and cached on first run; subsequent starts are offline-capable
- Every developer with the same CLI version gets the same default versions

**Why NOT "pull latest":** Fetching the latest version on each init would break reproducibility (two devs running `init` on different days get different stacks), require network access for greenfield projects, and provide no guarantee that the latest versions of different services are compatible with each other.

#### US2: Link to existing project

A user runs `supabase link <project-ref>` to connect to a remote Supabase project.

1. The CLI fetches service versions from the remote project:
   - Management API `GET /v1/projects/{ref}` → Postgres version
   - Tenant API `GET /rest/v1/` → PostgREST version (from Swagger `info.version`)
   - Tenant API `GET /auth/v1/health` → Auth version (from `version` field)
   - (Future: Storage, Realtime, Edge Runtime, etc.)
2. The CLI writes **all** fetched versions to `config.toml [versions]` — including versions for excluded services, so un-excluding later doesn't require re-linking
3. The CLI outputs the changes so the user sees exactly what happened:
   ```
   Linked to project abc123.
   Updated config.toml with remote service versions:
     postgres: 17.6.1.090
     postgrest: v14.5
     auth: v2.187.0
   ```
4. The change is visible in `git diff`, committable, and reviewable in PRs

#### US3: Version drift detection

After linking, the remote project may be upgraded by Supabase platform deployments. The local config.toml retains the versions from the last `link`.

- On every `supabase start` when the project is linked: a **non-blocking** check runs in parallel with startup
- Fetches current remote versions and compares with config.toml
- If offline: silently skips (graceful degradation)
- If drift detected: warns with an actionable message
  ```
  Service version drift detected (local → remote):
    auth: v2.187.0 → v2.190.0
    postgrest: v14.5 → v14.6
  Run `supabase link` to update config.toml.
  ```
- Does **NOT** auto-update config.toml — the user decides when to sync
- This ensures developers and AI agents using the CLI always know whether their local environment matches production

#### US4: Team collaboration

Because versions live in `config.toml`:

1. Developer A runs `supabase link`, which writes versions to config.toml
2. Developer A commits: `git commit -m "chore: pin service versions from linked project"`
3. Developer B pulls and runs `supabase start` — gets the exact same versions
4. No "works on my machine" version differences

The only team-inconsistency risk is if team members use different CLI versions with different `DEFAULT_VERSIONS` — but linked projects always have explicit versions in config.toml, so this only affects unlinked greenfield projects.

#### US5: CLI upgrade

User updates their CLI from v1.0 (ships `DEFAULT_VERSIONS.postgres = "17.6.1.080"`) to v2.0 (ships `DEFAULT_VERSIONS.postgres = "17.6.1.090"`).

- **Greenfield projects** (no explicit versions in config.toml): automatically use newer CLI defaults. This is desired — greenfield projects should use the latest tested versions.
- **Linked/pinned projects** (explicit versions in config.toml): no change. Explicit always wins. The CLI upgrade does not silently change pinned versions.
- When using CLI defaults, an informational message is shown:
  ```
  Using CLI default versions (postgres: 17.6.1.090, postgrest: v14.5, auth: v2.187.0).
  Pin versions in config.toml [versions] to prevent changes on CLI upgrade.
  ```

#### US6: Version pinning

A user wants to pin a specific version to reproduce a production bug.

- Edit `config.toml [versions]` directly:
  ```toml
  [versions]
  auth = "2.185.0"  # Pinning to reproduce AUTH-1234
  ```
- Other versions can remain omitted (using CLI defaults) or explicitly set
- The pin is visible in git, reversible, and doesn't affect other services
- An explicit pin overrides even linked project versions — the user is in control

### 10.5. Data Flow

```
config.toml [versions]           CLI DEFAULT_VERSIONS
  (explicit, optional)            (compiled into CLI)
          \                         /
           \                       /
            v                     v
      +----------------------------+
      |    resolveVersions()       |
      |    explicit ?? default     |
      +----------------------------+
                   |
           VersionManifest (fully resolved)
                   |
           StackConfig.versions
                   |
           +-------+---------+
           |                 |
           v                 v
     BinaryResolver    dockerImageForService()
     (native binary)   (Docker fallback)
           |                 |
           v                 v
      cache path         image:tag
           |                 |
           +--------+--------+
                    |
            ServiceDef (command + args)
                    |
                    v
             process-compose
```

The version resolution happens in the CLI's config loading layer, **before** constructing `StackConfig`. The `@supabase/local` library always receives a fully-resolved `VersionManifest` — it never deals with optionality or defaults.

### 10.6. Service Prefetching

`@supabase/local` exports a `prefetch()` function that ensures all service dependencies (native binaries and Docker images) are ready before they're needed. For each service, it tries the native binary first; if unavailable for the current platform, it falls back to pulling the Docker image.

The resolution logic lives in `resolveService()` — a shared helper used by both `prefetch()` and `StackBuilder.build()`, ensuring a single source of truth for the binary/Docker decision.

Available from the platform entry points (`@supabase/local/bun`, `@supabase/local/node`):

```ts
import { prefetch } from "@supabase/local/bun";

// Prefetch all services (default)
const result = await prefetch();
// => { postgres: { type: "binary", path: "..." }, auth: { type: "docker", image: "..." }, ... }

// Prefetch only specific services
await prefetch({ services: ["postgres", "postgrest"] });
```

Designed for vitest `globalSetup` so that test suites don't pay download/pull delays during execution.

### 10.7. Migration from Go CLI

For projects that have `.temp/*-version` files from the old Go CLI:

1. The new CLI detects `.temp/*-version` files during config loading
2. Reads the versions from them
3. Writes them to `config.toml` under `[versions]`
4. Informs the user: "Migrated service versions from .temp/ to config.toml. You can safely delete the .temp/ directory."
5. Going forward, the new CLI ignores `.temp/*-version` files
