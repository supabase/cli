<p align="center">
  <a href="https://supabase.com">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/supabase-cli-wordmark-dark.svg">
      <img src="./docs/assets/supabase-cli-wordmark-light.svg" alt="Supabase CLI" width="360">
    </picture>
  </a>
</p>

<p align="center">
  Develop locally and deploy to the Supabase Platform from your terminal.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/supabase"><img alt="npm" src="https://img.shields.io/npm/v/supabase?style=flat-square&color=3ECF8E"></a>
  <a href="https://github.com/supabase/cli/actions/workflows/test.yml"><img alt="Build" src="https://img.shields.io/github/actions/workflow/status/supabase/cli/test.yml?branch=develop&label=build&style=flat-square&color=3ECF8E"></a>
  <a href="https://www.npmjs.com/package/supabase"><img alt="License" src="https://img.shields.io/npm/l/supabase.svg?style=flat-square&color=3ECF8E"></a>
  <a href="https://discord.supabase.com"><img alt="Discord" src="https://img.shields.io/discord/839993398554656828?label=discord&style=flat-square&color=3ECF8E"></a>
</p>

---

Supabase CLI brings the Supabase Platform to your terminal. Run the full local stack, manage database migrations, deploy Edge Functions, generate types, and automate project workflows.

## Installation

```sh
# YOLO
curl -fsSL https://raw.githubusercontent.com/supabase/cli/main/install | bash

# npm
npm install -D supabase                   # or bun/pnpm/yarn add -D supabase
npm install -D supabase@beta              # beta channel

# macOS and Linux
brew install supabase/tap/supabase        # always up to date
brew install supabase                     # official formula, may be delayed
brew install supabase/tap/supabase-beta   # beta channel

# Windows
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
scoop install supabase-beta               # beta channel

# Linux packages
# Download .apk, .deb, .rpm, or .pkg.tar.zst from GitHub Releases.
```

Linux packages are available from [Releases](https://github.com/supabase/cli/releases). Community-maintained packages are also available through [pkgx](https://pkgx.sh/) and [Nixpkgs](https://nixos.org/).

## Start Local Development

Create a Supabase workspace and start the local stack:

```sh
supabase init
supabase start
supabase status
```

The local stack includes Postgres, Auth, Realtime, Storage, Edge Functions, and the Supabase APIs.

Start from a template:

```sh
supabase bootstrap
```

## Link A Project

Connect your local workspace to a hosted Supabase project:

```sh
supabase login
supabase link
```

## Manage Your Database

Create migrations, compare schemas, and apply changes locally or to your linked project:

```sh
supabase migration new create_profiles
supabase db diff
supabase db push
supabase db reset
```

## Deploy Edge Functions

Build, serve, and deploy functions from the same project workspace:

```sh
supabase functions new hello-world
supabase functions serve
supabase functions deploy hello-world
```

## Generate Types

Generate TypeScript types from your local database or linked project:

```sh
supabase gen types --local
supabase gen types --linked
```

## Reference

Use `--help` on any command to explore flags and examples:

```sh
supabase db --help
supabase functions deploy --help
```

- [CLI reference](https://supabase.com/docs/reference/cli/about)
- [Local development guide](https://supabase.com/docs/guides/local-development)
- [Supabase docs](https://supabase.com/docs)

## Developing

This repository is a pnpm monorepo. The published package lives in `apps/cli`.

```sh
pnpm install
cd apps/cli

pnpm dev:next -- --help
pnpm check:all
pnpm test:core
```

Useful source entry points:

| Path              | Purpose                                |
| ----------------- | -------------------------------------- |
| `apps/cli`        | TypeScript/Bun CLI package             |
| `apps/cli-go`     | Go CLI source used by the legacy shell |
| `packages/stack`  | Local Supabase stack runtime           |
| `packages/config` | Config schema and generated types      |
| `packages/api`    | Typed Supabase Management API client   |

After a fresh clone, install the reference repositories used for agent and developer inspection:

```sh
pnpm repos:install
```

## Contributing

We love focused pull requests with a clear problem, a small surface area, and tests that match the user-facing behavior. Before opening a PR, run the checks for the workspace you touched.

```sh
pnpm check:all
pnpm test
```

PR titles must use conventional commits, for example:

```text
fix(cli): handle linked projects without cached service versions
```

## License

Supabase CLI packages are released under the MIT license.
