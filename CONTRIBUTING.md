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
|   `-- nx-plugins/           # Local Nx Go inference plugin
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

Standard TypeScript workspaces (`apps/cli-e2e`, `apps/cli`, `packages/api`, `packages/cli-test-helpers`, `packages/config`, `packages/process-compose`, `packages/stack`) declare their package scripts explicitly. Test suites vary by package: unit tests are standard, while integration and e2e tests exist only where applicable.

| Script             | What it does                           |
| ------------------ | -------------------------------------- |
| `test`             | Run the package's declared test suites |
| `test:unit`        | Run unit tests                         |
| `test:integration` | Run integration tests where applicable |
| `test:e2e`         | Run end-to-end tests where applicable  |
| `types:check`      | Type-check with `tsc --noEmit`         |

The test and type-check scripts are declared in each package's `package.json`, so package-local commands are directly discoverable and can be sharded independently.

Linting, formatting, and unused-code analysis are repo-wide rather than per-package: `oxlint`, `oxfmt`, and `knip` read `.oxlintrc.json`, `.oxfmtrc.json`, and `knip.json` at the repo root (knip's config maps each workspace under its `workspaces` key). The root `check:all`/`fix:all` scripts are the sole repo-wide quality entrypoints and use Turbo to run the package type checks and root-owned quality scripts. Package-local work can run `pnpm types:check` and the package's test scripts. Running the tools directly from the repository root also just works:

```sh
pnpm exec oxlint
pnpm exec oxfmt
pnpm exec knip-bun
```

Package-local type checks and tests can be run from the workspace you are changing:

```sh
# From a project directory — scoped to that project only:
pnpm types:check
pnpm run test:unit
# If this package declares an integration suite:
pnpm run test:integration

# From the workspace root — repo-wide quality and all-project test fan-out:
pnpm run check:all
pnpm run fix:all
pnpm run test:unit && pnpm run test:integration
```

The root unit and integration scripts use Turbo to fan out the package-local
`test:*:run` tasks across the standard TypeScript/Vitest workspaces. The Go
workspace remains package-local because its tests run directly through Go:
`pnpm --dir apps/cli-go run test:unit`. Go tests are covered by the dedicated
Go CI workflow. Unit and integration tasks are uncached for now; e2e tasks are
also uncached and run one package at a time. Forward a Vitest shard to every
e2e package with `pnpm run test:e2e --shard=1/3`.

## E2E Compatibility Test Suite

`apps/cli-e2e` implements the replay-and-record compatibility harness for the TypeScript Legacy CLI (`ts-legacy`, the only shipped CLI shell). Live tests are owned by `apps/cli` and run from the command they cover. The CLI still shells out to the bundled Go binary for the handful of commands the TS port proxies (`db diff`, `db pull`, `db branch *`, `db remote *`, `gen keys`, `functions download`), so `apps/cli-go/` is built alongside the TS CLI for these suites, but there is no Go-vs-TypeScript parity runner.

### Architecture

Replay fixtures are recorded by running `ts-legacy` against the real Supabase staging API and capturing request/response pairs. Replay runs serve those committed fixtures back to the same CLI, so compatibility tests are fast and deterministic with no network access. The replay/record suite remains entirely under `apps/cli-e2e`.

The replay/record harness has two modes:

| Mode                 | When                 | What it does                                                                                                           |
| -------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Replay** (default) | Every PR / local dev | Loads committed fixtures; serves recorded responses to the CLI subprocess. Fast and deterministic — no network access. |
| **Record**           | `RECORD=true`        | Proxies CLI traffic to staging and captures request/response pairs as fixture files.                                   |

### Live remote-project coverage

The live suite lives in `apps/cli/src/**` as collocated `*.live.test.ts` files and runs in the CLI package's separate, serial `live` Vitest project. Global setup requires `SUPABASE_LIVE_API_URL` and `SUPABASE_ACCESS_TOKEN`, then provisions one uniquely named project through the typed Management API client, waits for it to become healthy, creates the shared storage fixture, and writes a temporary YAML profile. Every live subprocess receives that profile, so the same contract works with Supabox, a Docker-hosted API platform, or staging by changing only the URL and token. Teardown always removes the temporary profile and deletes the exact owned project unless `SUPABASE_LIVE_KEEP_PROJECT=1` is set.

The configured URL is the Management API endpoint. Tenant data-plane URLs keep
the CLI profile contract (`https://<ref>.<project_host>`) using the host derived
from the provisioned project's database metadata.

Live coverage is smoke coverage, not an exhaustive command matrix. Add one representative golden-path test for each user-facing command, colocated beside that command. A live test should assert one target command; setup and teardown may invoke other commands when they prepare or clean up state, but those commands are not asserted in that test. Keep validation, formatting, fallback, error, and matrix details in integration tests unless the remote/runtime boundary itself is the behavior under test. See [ADR 0013](docs/adr/0013-live-e2e-bypasses-replay-server.md) and [`apps/cli/live.env.example`](apps/cli/live.env.example).

To run the live suite locally, copy [`apps/cli/live.env.example`](apps/cli/live.env.example), set the API URL and access token for the target platform, and run the Nx target from the repository root. The target's build dependency prepares the CLI artifacts before Vitest starts:

```sh
pnpm exec nx run supabase:test:live
```

Optional `SUPABASE_LIVE_ORG_ID`, `SUPABASE_LIVE_REGION`, and
`SUPABASE_LIVE_PROJECT_NAME` values select provisioning details. Set
`SUPABASE_LIVE_KEEP_PROJECT=1` only when debugging a failed run; the temporary
profile is still cleaned up.

Live CI is manual or daily scheduled and is not PR-blocking; run it manually on a PR branch when you need pre-merge remote coverage.

### Running the tests

```sh
# Replay mode — fast, no credentials needed
cd apps/cli-e2e
pnpm test            # ts-legacy target (default and only target)
pnpm test:legacy     # ts-legacy target (explicit, same as above)

# Or via Turbo from the repo root
pnpm --filter @supabase/cli-e2e run test:e2e
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

Nx remains the task runner for the CLI build and live-test workflows. Quality
checks are root-owned `check:all`/`fix:all` scripts orchestrated with Turbo,
while ordinary unit, integration, and e2e tests remain package-local scripts;
see [Standard package scripts](#standard-package-scripts).

**Build the CLI and its Go sidecar:**

```sh
pnpm exec nx run supabase:build
```

**Run the live suite:**

The target's build dependency prepares the CLI artifacts before Vitest starts:

```sh
pnpm exec nx run supabase:test:live
```

Use `nx show project supabase` to inspect build/live dependencies and outputs.
Do not use Nx affected mode for quality checks; run `pnpm run check:all` or
`pnpm run fix:all` from the repository root instead. Package-local checks use
`pnpm types:check` plus the package's test scripts. See
[`docs/nx-inference-plugins.md`](docs/nx-inference-plugins.md) for the retained
Go plugin used by the Nx build graph.

## Documentation

- [`docs/adr/`](docs/adr/) contains architecture decision records.
- [`docs/`](docs/) contains design notes for CLI output, telemetry, environment management, distribution, migration, and monorepo tooling.
- [`apps/cli/docs/`](apps/cli/docs/) contains source material used to generate command documentation.

## Reference Repos

The repo keeps source checkouts in `.repos/` for local inspection while developing:

- `.repos/effect/` contains the complete Effect v4 source used as the reference implementation for types, APIs, and patterns.
