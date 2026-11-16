# Generated Management API commands

The CLI-owned generator reads `@supabase/api/openapi.json`: `x-cli` supplies command
names, flag renames, and waiters; OpenAPI supplies inputs, required fields,
descriptions, and experimental status. Committed descriptors and the review snapshot
also record each route and HTTP method.

## Generation and registration

`apps/cli/scripts/api-command-operations.ts` explicitly lists enabled operation IDs.
An empty list produces an empty registry without exposing any commands. Add an
operation only after its API contract and `x-cli` metadata are available.

Run `pnpm --filter supabase generate` to regenerate command data from the checked-in
API snapshot. Root `pnpm generate` refreshes the API first; the API sync workflow
also regenerates command data. Generator tests reject stale generated output.

Consumer command families use `makeApiCommand` with their generated descriptor and
own registration in the root command tree, including any family feature gate.
Experimental operations independently require `--experimental` or
`SUPABASE_EXPERIMENTAL=1` at execution time.

The first slice supports project-scoped JSON POST operations with scalar fields,
scalar arrays, nested objects, and the API's resource envelope. Unsupported shapes,
reserved flag collisions, unresolved renames, and invalid waiter references fail
generation. Body/file inputs, schema/search commands, and a general API escape hatch
belong to subsequent slices.

## Runtime behavior

The shared runtime reuses API input schemas, authentication, target resolution,
hosted consent, permissions, and telemetry. Success returns raw JSON when piped and
YAML on a terminal. Errors are JSON on stderr; targeting and progress diagnostics
also stay on stderr. There is no preview or dry run.

`--wait` binds read parameters to the accepted response, polls the read declared in
metadata, and returns its final response. `--timeout` bounds the wait. The server
owns validation and readiness; stopping the CLI does not cancel accepted work.

The API schema source controls generation. Select the runtime platform separately
with `--profile` or `SUPABASE_PROFILE`, using credentials for that platform.
