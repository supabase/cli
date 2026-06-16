# Functions Deploy E2E Fixtures

Manual test project for validating `supabase functions deploy` on the `feat/functions-deploy` branch.

## Quick start

1. Copy env template and fill in your throwaway project values:

   ```sh
   cp .env.local.example .env.local
   # edit .env.local
   source .env.local
   ```

2. Link the project (required for Track A):

   ```sh
   supabase link --project-ref "$SUPABASE_PROJECT_REF"
   ```

3. Build the CLI from the branch (from repo root):

   ```sh
   cd ../cli
   pnpm exec nx run supabase:build
   export SUPABASE_CLI="$(pwd)/apps/cli/dist/supabase-legacy"
   ```

   Or add `SUPABASE_CLI` to `.env.local` (see `.env.local.example`).

4. Verify setup:

   ```sh
   ./scripts/verify-setup.sh
   ```

5. Follow **[DEPLOY-E2E.md](./DEPLOY-E2E.md)** for the full playbook.

## Layout

| Path | Purpose |
|------|---------|
| `supabase/functions/deploy-e2e-*` | Edge Function fixtures (14 in bulk manifest) |
| `supabase/functions/_shared/` | Shared module (not a deployable function) |
| `scripts/deploy-matrix.sh` | Deploy command matrix helper |
| `scripts/invoke-matrix.sh` | HTTP verification after deploy |
| `scripts/verify-setup.sh` | Prerequisites checker before running matrix |
| `scripts/functions.txt` | Slugs included in deploy-all / invoke-all |

## Fixture index

| Slug | Exercises |
|------|-----------|
| `deploy-e2e-basic` | Minimal happy path |
| `deploy-e2e-local-imports` | Relative import graph |
| `deploy-e2e-scoped-map` | Function-scoped `deno.json` alias |
| `deploy-e2e-root-map` | Config `import_map` + root map file |
| `deploy-e2e-deprecated-map` | Deprecated `import_map.json` (expect warning) |
| `deploy-e2e-deno-jsonc` | JSONC comments in config |
| `deploy-e2e-custom-entry` | Non-default entrypoint |
| `deploy-e2e-static-in-fn` | In-function static files |
| `deploy-e2e-static-asset` | Static file outside `functions/` |
| `deploy-e2e-npm` | `npm:` specifier bundling |
| `deploy-e2e-jsr` | `jsr:` specifier |
| `deploy-e2e-dynamic-import` | Dynamic `import()` |
| `deploy-e2e-package-json` | `package.json` discovery (Docker) |
| `deploy-e2e-no-jwt` | `verify_jwt = false` |
| `deploy-e2e-jwt-required` | Default JWT verification |
| `deploy-e2e-remote-only` | `--prune` only (excluded from bulk deploy) |

## Scripts

```sh
# Deploy one slug, default mode, linked project
./scripts/deploy-matrix.sh default single linked

# Deploy all fixtures with Docker, explicit project ref
./scripts/deploy-matrix.sh docker all explicit-ref

# Invoke all deployed functions
./scripts/invoke-matrix.sh
```
