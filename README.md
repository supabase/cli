# Supabase CLI

[![Coverage Status](https://coveralls.io/repos/github/supabase/cli/badge.svg?branch=develop)](https://coveralls.io/github/supabase/cli?branch=develop) [![Bitbucket Pipelines](https://img.shields.io/bitbucket/pipelines/supabase-cli/setup-cli/master?style=flat-square&label=Bitbucket%20Canary)](https://bitbucket.org/supabase-cli/setup-cli/pipelines) [![Gitlab Pipeline Status](https://img.shields.io/gitlab/pipeline-status/sweatybridge%2Fsetup-cli?label=Gitlab%20Canary)
](https://gitlab.com/sweatybridge/setup-cli/-/pipelines)

[Supabase](https://supabase.io) is an open source Firebase alternative. We're building the features of Firebase using enterprise-grade open source tools.

This repository contains all the functionality for Supabase CLI.

- [x] Running Supabase locally
- [x] Managing database migrations
- [x] Creating and deploying Supabase Functions
- [x] Generating types directly from your database schema
- [x] Making authenticated HTTP requests to [Management API](https://supabase.com/docs/reference/api/introduction)

## Getting started

### Install the CLI

Available via [NPM](https://www.npmjs.com) as dev dependency. To install:

```bash
npm i supabase --save-dev
```

When installing with yarn 4, you need to disable experimental fetch with the following nodejs config.

```
NODE_OPTIONS=--no-experimental-fetch yarn add supabase
```

> **Note**
For Bun versions below v1.0.17, you must add `supabase` as a [trusted dependency](https://bun.sh/guides/install/trusted) before running `bun add -D supabase`.

<details>
  <summary><b>macOS</b></summary>

  Available via [Homebrew](https://brew.sh). To install:

  ```sh
  brew install supabase/tap/supabase
  ```

  To install the beta release channel:
  
  ```sh
  brew install supabase/tap/supabase-beta
  brew link --overwrite supabase-beta
  ```
  
  To upgrade:

  ```sh
  brew upgrade supabase
  ```
</details>

<details>
  <summary><b>Windows</b></summary>

  Available via [Scoop](https://scoop.sh). To install:

  ```powershell
  scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
  scoop install supabase
  ```

  To upgrade:

  ```powershell
  scoop update supabase
  ```
</details>

<details>
  <summary><b>Linux</b></summary>

  Available via [Homebrew](https://brew.sh) and Linux packages.

  #### via Homebrew

  To install:

  ```sh
  brew install supabase/tap/supabase
  ```

  To upgrade:

  ```sh
  brew upgrade supabase
  ```

  #### via Linux packages

  Linux packages are provided in [Releases](https://github.com/supabase/cli/releases). To install, download the `.apk`/`.deb`/`.rpm`/`.pkg.tar.zst` file depending on your package manager and run the respective commands.

  ```sh
  sudo apk add --allow-untrusted <...>.apk
  ```

  ```sh
  sudo dpkg -i <...>.deb
  ```

  ```sh
  sudo rpm -i <...>.rpm
  ```

  ```sh
  sudo pacman -U <...>.pkg.tar.zst
  ```
</details>

<details>
  <summary><b>Other Platforms</b></summary>

  You can also install the CLI via [go modules](https://go.dev/ref/mod#go-install) without the help of package managers.

  ```sh
  go install github.com/supabase/cli@latest
  ```

  Add a symlink to the binary in `$PATH` for easier access:

  ```sh
  ln -s "$(go env GOPATH)/bin/cli" /usr/bin/supabase
  ```

  This works on other non-standard Linux distros.
</details>

<details>
  <summary><b>Community Maintained Packages</b></summary>

  Available via [pkgx](https://pkgx.sh/). Package script [here](https://github.com/pkgxdev/pantry/blob/main/projects/supabase.com/cli/package.yml).
  To install in your working directory:

  ```bash
  pkgx install supabase
  ```

  Available via [Nixpkgs](https://nixos.org/). Package script [here](https://github.com/NixOS/nixpkgs/blob/master/pkgs/development/tools/supabase-cli/default.nix).
</details>

### Run the CLI

```bash
supabase bootstrap
```

Or using npx:

```bash
npx supabase bootstrap
```

The bootstrap command will guide you through the process of setting up a Supabase project using one of the [starter](https://github.com/supabase-community/supabase-samples/blob/main/samples.json) templates.

## Docs

Command & config reference can be found [here](https://supabase.com/docs/reference/cli/about).

## Breaking changes

We follow semantic versioning for changes that directly impact CLI commands, flags, and configurations.

However, due to dependencies on other service images, we cannot guarantee that schema migrations, seed.sql, and generated types will always work for the same CLI major version. If you need such guarantees, we encourage you to pin a specific version of CLI in package.json.

## Developing

To run from source:

```sh
# Go >= 1.22
go run . help
```

### Project Structure

```
Supabase-CLI/
├── .github/ # GitHub Actions workflows, automation, release pipelines
├── api/ # OpenAPI specs and generated API clients
├── cmd/ # CLI commands (Cobra entrypoints)
├── docs/ # Additional CLI documentation
├── examples/ # Example projects, functions, templates
├── fsevents/ # File system event helpers (primarily macOS)
├── internal/ # Core business logic for the CLI
│ ├── api/ # Wrapped API client logic
│ ├── db/ # Migrations, schema tooling, dump/reset logic
│ ├── functions/ # Edge Functions tooling (build, deploy, logs)
│ ├── local/ # Local development orchestration (Docker stack)
│ ├── testing/ # Mocks and helpers for unit tests
│ └── ... # Additional internal packages
├── main.go # CLI entrypoint
├── go.mod # Go module definition
├── go.sum
├── package.json # JS tooling (type generation, scripts)
├── README.md
├── LICENSE
├── .gitignore
├── .golangci.yml # Linter configuration
└── .goreleaser.yml # Build & release configuration
```
### Release Process

**Stable Release**
- Published every __two weeks__ from `main` 

**Beta Releases**
- Published every merge to `develop`

**Hotfix Releases**

Create branch `N.N.x` from latest stable

Cherry-pick changes

Run __Release (Beta)__ workflow

Test via:

```npx supabase@N.N.x help```

Mark release as latest stable

### Updating the API Client

The CLI’s API client is generated from Supabase’s OpenAPI schema. Regenerate when updating API definitions.

## Trouble Shooting

This section helps you fix common issues when running or developing the Supabase CLI.  

### Local Stack Won’t Start**  
**Problem:** `supabase start` hangs, errors, or services don’t respond.

**Common Causes**  
- Docker not Running
- Old containers/conflicting ports
- Missing environment files (`.env`)

**Fix**
```sh
# Make sure Docker is running
docker --version


# Stop any running Supabase stack
supabase stop


# Remove old containers if stuck
docker-compose down


# Start the local stack again
supabase start
```
### Database Migrations Out of Sync**

**Problem:** CLI shows errors like ``migration already applied`` or schema mismatch.

**Fix:**

- Reset the local database (WARNING: deletes all data)
```sh
supabase db reset
```
- Apply migrations fresh
```sh
supabase db push
```
### CLI Shows Unexpected Errors

**Problem:** Commands fail after updating CLI or Go version.

**Fix:**

- Clear Go cache
```sh
go clean -cache
```

- Rebuild CLI binary
```sh
go build -o supabase .
```

- Check CLI works
```sh
./supabase help
```
### TypeScript Type Generation Fails

**Problem:** `supabase gen types typescript` produces errors.

**Fix:**

- Ensure Node.js / npm / pnpm versions are correct

- Check database is running (`supabase start`)

```sh
npx supabase gen types typescript --local
```
### Edge Functions Deployment Fails

**Problem:** Functions don’t deploy or logs show errors.

**Fix:**

- Make sure Docker is running

- Ensure folder structure under ``supabase/functions/`` is correct

```sh
supabase functions build <function-name>
supabase functions deploy <function-name>
```

## Thanks for Contributing

Every contribution — docs, tests, or code — makes Supabase better for everyone.

For detailed contribution workflow, branching, testing, and PR guidelines, see [CONTRIBUTING.md](./CONTRIBUTING.md).
