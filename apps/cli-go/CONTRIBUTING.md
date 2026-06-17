# Welcome to Supabase CLI contributing guide

## Release process

We release to stable channel every two weeks via `main` branch.

We release to beta channel on merge to `develop` branch.

Hotfixes are released manually. Follow these steps:

1. Create a new branch named `N.N.x` from latest stable version. For eg.
   1. If stable is on `v1.2.3` and beta is on `v1.3.6`, create `1.2.x` branch.
   2. If stable is on `v1.3.1` and beta is on `v1.3.6`, create `1.3.x` branch (or simply release all patch versions).
2. Cherry-pick your hotfix on top of `N.N.x` branch.
3. Run the [Release (Beta)](https://github.com/supabase/cli/actions/workflows/release-beta.yml) workflow targetting `N.N.x` branch.
4. Verify your hotfix locally with `npx supabase@N.N.x help`
5. Edit [GitHub releases](https://github.com/supabase/cli/releases) to set your hotfix pre-release as latest stable.

After promoting the next beta version to stable, previous `N.N.x` branches may be deleted.

To revert a stable release, set a previous release to latest. This will update brew and scoop to an old version. There's no need to revert npm as it supports version pinning.

## Unit testing

All new code should aim to improve [test coverage](https://coveralls.io/github/supabase/cli).

We use mock objects for unit testing code that interacts with external systems, such as

- local filesystem (via [afero](https://github.com/spf13/afero))
- Postgres database (via [pgmock](https://github.com/jackc/pgmock))
- Supabase API (via [gock](https://github.com/h2non/gock))

Wrappers and test helper methods can be found under [internal/testing](internal/testing).

Integration tests are created under [test](test). To run all tests:

```bash
go test ./... -race -v -count=1 -failfast
```

## API client

The Supabase API client is generated from OpenAPI spec. See [our guide](api/README.md) for updating the client and types.

## Testing local pg-delta builds

To exercise unpublished `@supabase/pg-delta` changes inside CLI edge-runtime scripts (`db pull`, `db diff`, `db push`, etc.), publish a local build via Verdaccio in [pg-toolbelt](https://github.com/supabase/pg-toolbelt) and point the CLI at that registry.

### 1. Start Verdaccio (pg-toolbelt)

```sh
cd pg-toolbelt
bun run verdaccio:start
```

Verdaccio listens on `http://localhost:4873`. `@supabase/*` packages you publish locally are served from local storage; other `@supabase/*` dependencies (for example `@supabase/pg-topo`) are proxied to npmjs.

### 2. Publish a local pg-delta build

After changing `packages/pg-delta`:

```sh
bun run pg-delta:publish-local \
  --write-version-to=/path/to/test-project/supabase/.temp/pgdelta-version
```

This publishes a fresh `0.0.0-local.<timestamp>` version and restores `package.json` afterward. The version file tells the CLI which npm version to request (`EffectivePgDeltaNpmVersion`).

Re-run whenever you change pg-delta source.

### 3. Run the CLI against the local registry

Set `PGDELTA_NPM_REGISTRY` to a URL reachable **from inside the edge-runtime Docker container**:

```sh
# Docker Desktop (macOS / Windows)
export PGDELTA_NPM_REGISTRY=http://host.docker.internal:4873

# Linux (Docker 20.10+)
export PGDELTA_NPM_REGISTRY=http://host.docker.internal:4873
# or: export PGDELTA_NPM_REGISTRY=http://172.17.0.1:4873
```

Then run any pg-delta-backed command, for example:

```sh
supabase db pull --db-url "$DATABASE_URL" --diff-engine pg-delta
```

When set, the CLI injects a scoped `.npmrc` and forwards `NPM_CONFIG_REGISTRY` into the edge-runtime container (`PgDeltaNpmRegistryOption` in `internal/utils/pgdelta_local.go`).

Unset `PGDELTA_NPM_REGISTRY` to return to the npmjs version pinned in config / `supabase/.temp/pgdelta-version`.
