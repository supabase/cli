# Supabase CLI (WIP)

[![Coverage Status](https://coveralls.io/repos/github/supabase/cli/badge.svg?branch=main)](https://coveralls.io/github/supabase/cli?branch=main)

[Supabase](https://supabase.io) is an open source Firebase alternative. We're building the features of Firebase using enterprise-grade open source tools.

This repository contains all the functionality for our CLI. It is still under heavy development.

- [x] Running Supabase locally
- [x] Managing database migrations
- [x] Pushing your local changes to production
- [x] Create and Deploy Supabase Functions
- [ ] Manage your Supabase Account
- [ ] Manage your Supabase Projects
- [ ] Generating types directly from your database schema
- [ ] Generating API and validation schemas from your database

## Getting started

### Install the CLI

#### macOS

Available via [Homebrew](https://brew.sh). To install:

```sh
brew install supabase/tap/supabase
```

To upgrade:

```sh
brew upgrade supabase
```

#### Windows

Available via [Scoop](https://scoop.sh). To install:

```powershell
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase
```

To upgrade:

```powershell
scoop update supabase
```

#### Linux

Available via [Homebrew](https://brew.sh) and Linux packages.

##### via Homebrew

To install:

```sh
brew install supabase/tap/supabase
```

To upgrade:

```sh
brew upgrade supabase
```

##### via Linux packages

Linux packages are provided in [Releases](https://github.com/supabase/cli/releases). To install, download the `.apk`/`.deb`/`.rpm` file depending on your package manager and run `sudo apk add --allow-untrusted <...>.apk`/`sudo dpkg -i <...>.deb`/`sudo rpm -i <...>.rpm` respectively.

### Run the CLI

```sh
supabase help
```

## Docs

Command & config reference can be found [here](https://supabase.com/docs/reference/cli/about).

## Breaking changes

The CLI is a WIP and we're still exploring the design, so expect a lot of breaking changes. We try to document migration steps in [Releases](https://github.com/supabase/cli/releases). Please file an issue if these steps don't work!

## Developing

To run from source:

```sh
# Go >= 1.18
go run . help
```

---

## Sponsors

[![New Sponsor](https://user-images.githubusercontent.com/10214025/90518111-e74bbb00-e198-11ea-8f88-c9e3c1aa4b5b.png)](https://github.com/sponsors/supabase)
