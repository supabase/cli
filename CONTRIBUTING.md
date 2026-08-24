# Supabase

Bun monorepo for exploring the next generation of the Supabase CLI and local development stack.

## Contribution workflow

Before you open a pull request:

1. **Open an issue first**, using one of the [issue templates](https://github.com/supabase/cli/issues/new/choose).
2. **Wait for maintainer triage.** A maintainer categorizes the issue (`✨ Feature`, `🐛 Bug`, or `📘 Docs`) and adds the **`open-for-contribution`** label once it is ready to be worked on.
3. **Open a pull request only after the `open-for-contribution` label is set**, and link the issue with a closing keyword (for example `Closes #123`).

Until the `open-for-contribution` label is present, the issue is still in triage, so work should not start and a pull request should not be opened.

Pull requests from external contributors that do not follow this workflow are commented on and closed automatically by the [Contribution Gate](.github/workflows/contribution-gate.yml). Supabase members are exempt, so they can work from Linear tickets that are not public on GitHub. Maintainers: see [`.github/MAINTAINERS.md`](.github/MAINTAINERS.md).

## Setup

### Tool versions

This repo pins the versions of Node, Bun, Go, pnpm, and golangci-lint that contributors are expected to build against, and uses [`mise`](https://mise.jdx.dev/) — a polyglot version manager — to install and activate them automatically. If you don't already have these tools installed, `mise` is a great way to get up and running quickly.

#### Installing mise

```sh
# macOS / Linux
curl https://mise.run | sh

# macOS via Homebrew
brew install mise
```

See the [`mise` installation docs](https://mise.jdx.dev/getting-started.html) for other package managers (apt, dnf, cargo, npm, Windows, …).

`mise` needs to hook into your shell so it can inject the right tool versions into your `PATH` as you move between directories. Follow the `mise activate` instructions [in this section](https://mise.jdx.dev/getting-started.html#activate-mise) to add the activation line for your shell to its startup file.

This repo relies on `mise` support for reading Node and pnpm versions from `package.json`, so use mise `2026.7.0` or newer.

#### Installing the pinned tool versions

Trust this repo's `mise.toml` once from the repo root so `mise` can read the project setting that enables idiomatic version files:

```sh
mise trust
```

Then install the pinned tool versions:

```sh
mise install
```

`mise install` resolves the versions this repo expects from a handful of files, rather than hardcoding them all in one place:

| Tool          | Version source                               |
| ------------- | -------------------------------------------- |
| Bun           | `.bun-version`                               |
| Node.js       | `devEngines.runtime` field in `package.json` |
| pnpm          | `packageManager` field in `package.json`     |
| Go            | `mise.toml`                                  |
| golangci-lint | `mise.toml`                                  |

The Go and golangci-lint entries in `mise.toml` are intentionally temporary while the Go CLI remains in the repo. The canonical Go module metadata still lives in `apps/cli-go/go.mod`; keep the `mise.toml` entries aligned only until the Go code is removed.

Once installed, `mise` activates these versions automatically whenever your shell is inside this repo — no manual `nvm use`, `gvm use`, or similar switching required.

#### Without mise

`mise` is not required. If you already have Bun, Node, pnpm, and Go installed and managed some other way, just make sure your versions match the ones pinned in `.bun-version`, `mise.toml`, `package.json`, and `apps/cli-go/go.mod`.

### Install dependencies

Install workspace dependencies:

```sh
pnpm install
```

Clone the reference submodules used during development:

```sh
bun run repos:install
```

That pulls `.repos/effect/`, which is the local source of truth for Effect v4 APIs and patterns in this repo.

## Workspace Layout

```text
.
|-- apps/
|   |-- cli/   # Published Supabase CLI package
|   `-- docs/  # Next.js docs site generated from the CLI
|-- packages/
|   |-- api/                  # Typed Supabase Management API client
|   |-- config/               # Supabase config schema and generated types
|   |-- process-compose/      # Effect-based process orchestration library
|   |-- stack/                # Programmatic local Supabase stack runtime
|   `-- cli-*/                # Platform-specific CLI binary packages
|-- tools/
|   `-- nx-plugins/           # Local Nx inference plugins
|-- docs/                     # ADRs, design notes, and implementation docs
`-- .repos/effect/            # Effect v4 reference source
```

## Apps

| Workspace      | Purpose                                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/cli`     | Main `supabase` package. Contains command handlers, runtime services, auth, output, telemetry, and docs generation scripts.            |
| `apps/cli-e2e` | Compatibility e2e test suite. Record-and-replay harness for testing the TS Legacy port against real Supabase Management API responses. |
| `apps/docs`    | Internal docs site built with Next.js and generated from the CLI docs sources.                                                         |

## Packages

| Workspace                       | Purpose                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/api`                  | Auto-generated TypeScript client for the Supabase Management API.                                                   |
| `packages/cli-test-helpers`     | CLI test harness library — `createHarness`/`exec` API for spawning TS Legacy and TS Next CLI subprocesses in tests. |
| `packages/config`               | JSON Schema and generated TypeScript types for Supabase configuration.                                              |
| `packages/process-compose`      | TypeScript/Bun port of `process-compose` used for multi-service orchestration.                                      |
| `packages/stack`                | Programmatic local Supabase stack used by the CLI and other tooling.                                                |
| `packages/cli-darwin-arm64`     | Published native CLI binary wrapper for macOS arm64.                                                                |
| `packages/cli-darwin-x64`       | Published native CLI binary wrapper for macOS x64.                                                                  |
| `packages/cli-linux-arm64`      | Published native CLI binary wrapper for Linux arm64 (glibc).                                                        |
| `packages/cli-linux-arm64-musl` | Published native CLI binary wrapper for Linux arm64 (musl).                                                         |
| `packages/cli-linux-x64`        | Published native CLI binary wrapper for Linux x64 (glibc).                                                          |
| `packages/cli-linux-x64-musl`   | Published native CLI binary wrapper for Linux x64 (musl).                                                           |
| `packages/cli-windows-x64`      | Published native CLI binary wrapper for Windows x64.                                                                |

## Working In The Monorepo

Root-level scripts:

```sh
pnpm run repos:install
pnpm run repos:pull
pnpm run check:all   # run all checks across every project
pnpm run fix:all     # run all fixers across every project
```

### Standard package scripts

All standard TypeScript workspaces (`apps/cli`, `packages/api`, `packages/config`, `packages/process-compose`, `packages/stack`) expose the following scripts:

| Script             | What it does                                                                   |
| ------------------ | ------------------------------------------------------------------------------ |
| `test`             | Run the full test suite (unit + integration + e2e)                             |
| `test:core`        | Run unit and integration tests                                                 |
| `test:unit`        | Run unit tests _(inferred by Nx plugin)_                                       |
| `test:integration` | Run integration tests _(inferred by Nx plugin)_                                |
| `test:e2e`         | Run end-to-end tests _(inferred by Nx plugin)_                                 |
| `check:all`        | Run all check targets for this project                                         |
| `fix:all`          | Run all fix targets for this project                                           |
| `types:check`      | Type-check with `tsc --noEmit` _(inferred by Nx plugin)_                       |
| `lint:check`       | Check for lint errors with `oxlint` _(inferred by Nx plugin)_                  |
| `lint:fix`         | Auto-fix lint errors _(inferred by Nx plugin)_                                 |
| `fmt:check`        | Check formatting with `oxfmt --check` _(inferred by Nx plugin)_                |
| `fmt:fix`          | Auto-fix formatting _(inferred by Nx plugin)_                                  |
| `knip:check`       | Find unused exports and dependencies with `knip-bun` _(inferred by Nx plugin)_ |
| `knip:fix`         | Auto-remove unused exports and dependencies _(inferred by Nx plugin)_          |

The inferred scripts (`test:unit`, `test:integration`, `test:e2e`, `types:check`, `lint:*`, `fmt:*`, `knip:*`) are not declared in `package.json` — they are injected by local Nx plugins in `tools/nx-plugins/`. They are fully cached and can be discovered via `nx show project <name>`.

Quality checks are run from the workspace you are changing:

```sh
# From a project directory — scoped to that project only:
pnpm run check:all
pnpm run fix:all
pnpm run test

# From the workspace root — runs across all projects:
pnpm run check:all
```

## E2E Compatibility Test Suite

`apps/cli-e2e` implements a record-and-replay test harness for testing the TypeScript Legacy CLI (`ts-legacy`, the only shipped CLI shell) against real Supabase Management API responses without hitting staging on every run. It still shells out to the bundled Go binary for the handful of commands the TS port proxies (`db diff`, `db pull`, `db branch *`, `db remote *`, `gen keys`, `functions download`), so `apps/cli-go/` is built alongside the TS CLI for this suite, but the suite itself no longer compares Go and TS output — that go-target parity harness was retired once the legacy port and the CLI-1970 Go binary trim landed.

### Architecture

Fixtures are recorded by running `ts-legacy` against the real Supabase staging API and capturing the request/response pairs. Every other run replays those committed fixtures against the same CLI, so tests are fast and deterministic with no network access.

The harness works in two modes:

| Mode                 | When                 | What it does                                                                                                           |
| -------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Replay** (default) | Every PR / local dev | Loads committed fixtures; serves recorded responses to the CLI subprocess. Fast and deterministic — no network access. |
| **Record**           | `RECORD=true`        | Proxies CLI traffic to staging and captures request/response pairs as fixture files.                                   |

### Running the tests

```sh
# Replay mode — fast, no credentials needed
cd apps/cli-e2e
pnpm test            # ts-legacy target (default and only target)
pnpm test:legacy     # ts-legacy target (explicit, same as above)

# Or via Nx from the repo root
nx run @supabase/cli-e2e:test:e2e
```

### Recording fixtures

Recording proxies CLI traffic to the Supabase staging API. Provide a staging access token and a project ref for commands that need one — everything else is baked into the script:

```sh
cd apps/cli-e2e
SUPABASE_ACCESS_TOKEN=<your-staging-token> SUPABASE_TEST_PROJECT_REF=<your-project-ref> SUPABASE_STAGING_URL=<stagingUrl> pnpm record
```

Review the generated files in `apps/cli-e2e/fixtures/recorded/` before committing — verify that no real tokens, UUIDs, or project refs appear (they should be replaced with `__ACCESS_TOKEN__`, `__UUID__`, `__PROJECT_REF__` placeholders).

### Verifying fixtures

After recording, replay must pass with no changes against the freshly committed fixtures:

```sh
pnpm test:legacy
```

A test failing only after a recording session usually means an assertion needs updating to match the CLI's current real-world output, not the fixture.

### Fixture layout

```text
apps/cli-e2e/fixtures/
├── recorded/           # Committed fixture pairs, captured from real staging responses
│   └── <KEY>/          # e.g. GET_v1_projects/
│       ├── default.request.json
│       └── default.response.json
├── errors/             # Manually crafted error fixtures (401, 403, 404, …)
└── scenarios/          # Reserved for stateful workflow tests (Tier 2)
```

Fixture files must never contain real tokens, UUIDs, or project IDs. The recording step replaces all dynamic values with stable placeholders automatically.

### CLI harness library

Test code imports from `@supabase/cli-test-helpers` (`packages/cli-test-helpers`):

```ts
import { createHarness, exec } from "@supabase/cli-test-helpers";

const harness = createHarness("ts-legacy", { apiUrl, accessToken });
const result = await exec(harness, ["projects", "list"]);
```

---

## Local Release Testing

Test a real end-to-end publish and install of the CLI against a local npm registry (Verdaccio), without touching `npm` and without modifying any git-tracked files.

### Prerequisites

- **Bun** — for compiling the CLI binary and running the scripts
- **Go** — only required for `--legacy` shell (commands proxied to the Go binary)
- **pnpm** — already required by this repo
- **Node.js** — required by `npx` / `npm install -g` to test the published package

### Workflow

**Terminal 1 — start the local registry:**

```sh
pnpm local-registry
```

This starts Verdaccio on `http://localhost:4873` and creates a publish user. Your global `npm` and `pnpm` registry config is never modified — every command that talks to the local registry passes `--registry` explicitly. Press **Ctrl+C** when done.

**Terminal 2 — build and publish:**

```sh
# Publish the next (TypeScript-native) shell
pnpm cli-release --next

# Or publish the legacy (Go-backed) shell
pnpm cli-release --legacy

# Pin a specific version (default: 0.0.0-local.<epoch-seconds>)
pnpm cli-release --next --version 0.0.0-local.1
```

The script builds the CLI binary for the current platform only, compiles the Node.js shim, and publishes two packages to the local registry:

- `@supabase/cli-<platform>@<version>` — the compiled binary
- `supabase@<version>` — the shim that resolves and execs the binary

No git-tracked files are modified. Build output goes to a system temp directory that is deleted after publish.

### Testing the published package

```sh
# Run directly with npx
npx --registry http://localhost:4873 supabase@0.0.0-local.1 --version

# Or install globally and run as `supabase`
npm install -g --registry http://localhost:4873 supabase@0.0.0-local.1
supabase --version
```

### Troubleshooting

| Problem                                                                         | Fix                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Error: Something is already running on port 4873`                              | Kill the leftover Verdaccio process (`lsof -ti:4873 \| xargs kill`) and retry                                                                                                                                                                                                                                                                                                                                   |
| `go not found in PATH` (legacy only)                                            | Install Go from https://go.dev/dl/                                                                                                                                                                                                                                                                                                                                                                              |
| `Error: Go CLI source not found` (legacy only)                                  | Run `pnpm repos:install` to clone `apps/cli-go`                                                                                                                                                                                                                                                                                                                                                                 |
| `npm` / `pnpm` tries to fetch from `localhost:4873` when no registry is running | Stale global registry override left behind by an older version of `local-registry.ts` (the current script never modifies global config). Run `npm config delete registry` and `pnpm config delete registry`. Note that pnpm stores the override in its own global config (`~/Library/Preferences/pnpm/auth.ini` on macOS, `~/.config/pnpm/` on Linux), not `~/.npmrc` — check there if the delete command fails |
| `npx` resolves from npm instead of local                                        | Pass `--registry http://localhost:4873` explicitly to `npx` / `npm install`                                                                                                                                                                                                                                                                                                                                     |

## Using Nx

Nx is the task runner for this repo. It handles caching, parallelism, and cross-project orchestration. All tasks — whether declared in a project's `package.json` or inferred by a plugin — are invoked the same way.

**Run a single target:**

```sh
nx run @supabase/api:knip:check
nx run supabase:test
```

**Run a target across all projects:**

```sh
nx run-many -t knip:check
nx run-many -t lint:check fmt:check types:check knip:check
```

**Run only affected projects** (compared to `main`):

```sh
nx affected -t test
nx affected -t lint:check fmt:check types:check knip:check
```

**Inspect a project's full task configuration** (including inferred targets):

```sh
nx show project @supabase/api
```

This is the best way to see what targets exist on a project, what their inputs and outputs are, and whether they are cached. Some targets are not declared in `package.json` but are injected by local Nx plugins — `knip:check` and `knip:fix` are examples of this.

### Caching

Nx caches task results locally under `.nx/cache`. A target hits the cache when all its inputs are unchanged since the last successful run — inputs include source files, named input sets like `sharedGlobals`, and external dependency versions.

To force a re-run and bypass the cache:

```sh
nx run @supabase/api:knip:check --skip-nx-cache
```

To clear all cached results:

```sh
nx reset
```

### Inferred targets

Several targets in this repo are not explicitly declared in any project file. They are injected by local plugins in `tools/nx-plugins/` that inspect each package's `package.json` and derive targets from the tooling configuration found there.

To see the full list of targets for a project, always use `nx show project` rather than reading the `nx.targets` field in `package.json` directly.

See [`docs/nx-inference-plugins.md`](docs/nx-inference-plugins.md) for how the plugin system works and how to add new plugins.

## Documentation

- [`docs/adr/`](docs/adr/) contains architecture decision records.
- [`docs/`](docs/) contains design notes for CLI output, telemetry, environment management, distribution, migration, and monorepo tooling.
- [`apps/cli/docs/`](apps/cli/docs/) contains source material used to generate command documentation.

## Reference Repos

The repo keeps source checkouts in `.repos/` for local inspection while developing:

- `.repos/effect/` contains the complete Effect v4 source used as the reference implementation for types, APIs, and patterns.
