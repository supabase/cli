# Welcome to Supabase CLI contributing guide

## Release process

We release to stable channel once every two weeks.

We release to beta channel on merge to `main` branch.

Hotfixes are released manually. The steps are:

1. Create a new branch named `v*.*.*` from latest stable version. For eg.
   1. If stable is on `v1.2.3` and beta is on `v1.3.1`, create `v1.2.4` and confirm it's a new tag.
   2. If stable is on `v1.2.3` and beta is on `v1.2.6`, create `v1.2.7` or simply release all patch versions.
2. Run the [Release (Beta)](https://github.com/supabase/cli/actions/workflows/release-beta.yml) workflow targetting your new branch.
3. Update your local CLI to latest beta version to verify your fix.
4. Once verified, edit [GitHub releases](https://github.com/supabase/cli/releases) to set your pre-release as latest.

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
