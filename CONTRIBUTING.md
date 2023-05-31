# Welcome to Supabase CLI contributing guide

## Release process

We release to stable channel every two weeks.

We release to beta channel on merge to `main` branch.

Hotfixes are released manually. Follow these steps:

1. Create a new branch named `N.N.x` from latest stable version. For eg.
   1. If stable is on `v1.2.3` and beta is on `v1.3.6`, create `1.2.x` branch.
   2. If stable is on `v1.3.1` and beta is on `v1.3.6`, create `1.3.x` branch (or simply release all patch versions).
2. Cherry-pick your hotfix on top of `N.N.x` branch.
3. Run the [Release (Beta)](https://github.com/supabase/cli/actions/workflows/release-beta.yml) workflow targetting `N.N.x` branch.
4. Verify your fix by running the hotfix version locally, eg. `npx supabase@N.N.x help`
5. Edit [GitHub releases](https://github.com/supabase/cli/releases) to set your pre-release as latest stable.

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
