# Supabase CLI MkII (WIP)

[Supabase](https://supabase.io) is an open source Firebase alternative. We're building the features of Firebase using enterprise-grade open source tools.

This repository contains all the functionality for our CLI. It is still under heavy development.

- [x] Running Supabase locally
- [ ] Managing database migrations (in progress)
- [ ] Pushing your local changes to production (in progress)
- [ ] Self-hosting
- [ ] Manage your Supabase Account
- [ ] Manage your Supabase Projects
- [ ] Generating types directly from your database schema
- [ ] Generating API and validation schemas from your database

## Getting started

### Install the CLI

#### macOS

```sh
brew install supabase/tap/supabase
```

#### Windows

```
scoop bucket add supabase https://github.com/supabase/scoop-bucket.git
scoop install supabase/supabase
```

#### Linux

Linux packages are provided in [Releases](https://github.com/supabase/cli/releases). To install, download the `.apk`/`.deb`/`.rpm` file depending on your package manager and run `sudo apk add --allow-untrusted <...>.apk`/`sudo dpkg -i <...>.deb`/`sudo rpm -i <...>.rpm` respectively.

### Run the CLI

```sh
supabase help
```

## Command reference

```
Usage:
  supabase [command]

Available Commands:
  db dump         Diffs the local database with current migrations, writing it as a new migration, and writes a new structured dump.
  db restore      Restores the local database to reflect current migrations. Any changes on the local database that is not dumped will be lost.
  deploy          Deploy current migrations to prod.
  help            Help about any command
  init            Initialize a project to use Supabase CLI.
  link            Link the current project to a remote deploy database.
  start           Start the Supabase local development setup.

Flags:
  -h, --help      help for supabase
  -v, --version   version for supabase
```

## Developing

To run from source:

```sh
# Go >= 1.16
go run -ldflags "-X github.com/supabase/cli/cmd.version=0.0.0" main.go help
```

---

## Sponsors

[![New Sponsor](https://user-images.githubusercontent.com/10214025/90518111-e74bbb00-e198-11ea-8f88-c9e3c1aa4b5b.png)](https://github.com/sponsors/supabase)
