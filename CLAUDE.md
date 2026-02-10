# Supa

Bun monorepo with workspaces under `packages/`.

## Package Structure

All packages should follow this standard structure (see `packages/process-compose` as reference):

**package.json:**

- `name`: `@supabase/<package-name>`
- `private`: true
- `type`: "module"
- Standard scripts: `test`, `types:check`, `lint:check`, `lint:fix`, `fmt:check`, `fmt:fix`, `knip:check`, `knip:fix`
- Standard devDependencies: `@tsconfig/bun`, `@types/bun`, `@typescript/native-preview`, `knip`, `oxfmt`, `oxlint`, `oxlint-tsgolint`

**tsconfig.json:**

```json
{
  "extends": "@tsconfig/bun/tsconfig.json"
}
```

## Code Quality

Always run these scripts from the package directory after making any changes — do not consider a task complete until all pass:

```sh
bun run --parallel "*:check"   # Run all quality checks in parallel
bun run --parallel "*:fix"     # Auto-fix lint, format, and unused exports in parallel
bun test                       # Run tests
```
