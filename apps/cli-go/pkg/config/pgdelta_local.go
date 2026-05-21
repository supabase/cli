package config

// PgDeltaNpmRegistryEnv is the env var that, when set to an npm registry URL
// reachable from the edge-runtime container, routes Deno's `npm:` resolution
// for `@supabase/pg-delta` through that registry instead of the public
// npmjs.org. Pair with the pg-toolbelt `bun run pg-delta:publish-local` script
// to iterate on local pg-delta changes without republishing to npmjs.
//
// See apps/cli-go/CONTRIBUTING.md#testing-local-pg-delta-builds for the
// Verdaccio workflow (CLI maintainers only).
//
// Typical value when running pg-toolbelt's Verdaccio on Docker Desktop:
//   PGDELTA_NPM_REGISTRY=http://host.docker.internal:4873
const PgDeltaNpmRegistryEnv = "PGDELTA_NPM_REGISTRY"
