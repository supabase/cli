# Command Contract Spike

Plan for the spike in [RFC: A Command Contract for the Supabase CLI](https://linear.app/supabase/document/rfc-a-command-contract-for-the-supabase-cli-4753ba96a6bd).

Status values: `not started`, `in progress`, `blocked`, `done`, `dropped`.

Status: in progress

## Goal

Annotate three commands fully, generate their help, docs-spec entry and `describe` JSON from the annotations, and check their Management API calls at a boundary. The measurements answer the RFC's open question: declarations only, a typed client per command, or the full boundary.

Nothing merges to `develop` until the spike is reviewed.

## Candidates

| Command           | Order | What it tests                                                                                                                                                                                                                     | Bad at                                                                       |
| ----------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `branches delete` | 1     | Management API boundary; delete target from input (20-letter ref) or from a lookup (name or UUID); operations composed from shared blocks                                                                                         | Small output, no `config.toml`, a single write, no hand-kept docs to retire  |
| `secrets set`     | 2     | Configuration declaration (`[edge_runtime.secrets]`, `[remotes.*]`, `.env*`, `--env-file`); write cap that depends on input (ceil(n/100) batches); retiring hand-kept docs; secret values kept out of `describe`, docs and errors | 335-line handler with config recovery, so boundary cost is harder to isolate |
| `branches get`    | 3     | Output declaration across `-o` formats and `--output-format`; operations that depend on flags (`MACHINE_OUTPUT` in `get.command.ts`); masked sensitive fields                                                                     | Read-only, so no write checks; same family as `branches delete`              |

Rejected: `config push` (731-line handler plus 1,628 lines of encoders hide the boundary cost), `branches list` (`branches get` covers its output modes), commands that reach Docker, Postgres or the filesystem (outside the Management API boundary).

## Shared Work

- [ ] Define the six annotations on Effect CLI commands (`Command.annotate`, read with `Context.getOption`), building on `withPermissions`.
- [ ] Guarded Management API client: matches each request to an operation, checks the declared target, counts writes, refuses unknown requests.
- [ ] Remove the raw `HttpClient.HttpClient` from `ManagementApiServices` (`apps/cli/src/command-internal/management-api-runtime.layer.ts:112-123`) so an undeclared call fails to compile.
- [ ] Run the guarded client over `mockCommandPlatformApi` (`apps/cli/tests/helpers/command-mocks.ts:562`) so the runtime checks run in integration tests.
- [ ] Generators: `--help`, the docs-spec entry and a `describe` JSON, each read from annotations alone.
- [ ] Decide how the filesystem side writes (`linked-project.json`, `telemetry.json`) are declared, or record them as out of scope for this boundary.
- [ ] Measure startup across the full command tree with the annotations loaded.

## `branches delete`

Status: not started

- [ ] Annotate all six declarations.
- [ ] Generate `--help`, docs-spec entry and `describe` JSON; diff against current output.
- [ ] Route API calls through the guarded client.
- [ ] Tests that must fail: undeclared operation (compile time), delete of an ID the lookup didn't return, a second delete, an unmatched request.
- [ ] Record handler changes needed.

## `secrets set`

Status: contract annotated (`apps/cli/src/commands/secrets/set/set.contract.ts`); `writes` left empty.

- The compile check found 33 undeclared errors on the first pass with `errors: []`, including six `LinkBranch*` errors from `branchResolution` and five config-load errors.
- `configKeys` is empty. The handler reads `[edge_runtime.secrets]` as a subtree through `resolveCliSubtree`, and the registry has no key for `edge_runtime.secrets` or any `remotes.*` path. A contract can't name a subtree read with `CliConfigKey` references.
- `writes` can't express the cap: `max` is a number, and the handler sends ceil(n/100) `v1-bulk-create-secrets` batches.

- [ ] Annotate all six declarations, including the config keys and settings it reads.
- [ ] Declare a write cap that depends on input count; record whether the declaration format supports it or needs a change.
- [ ] Confirm secret values never appear in `describe`, generated docs or error output.
- [ ] Retire `DOCS_ARG_OVERRIDES["supabase-secrets-set"]` (`apps/cli/src/docs/docs-spec.tables.ts:194`) and fold `Command.withExamples` and `apps/cli/docs/supabase/secrets.md` into annotations where possible.
- [ ] Record handler changes needed.

## `branches get`

Status: not started

- [ ] Declare output schemas for every `-o` format and `--output-format`.
- [ ] Declare the flag-dependent operations; record where a typed client per command can't express the condition at compile time.
- [ ] Confirm masked fields (`db_pass`, `jwt_secret`, API keys) are declared as sensitive in the output schema.
- [ ] Record handler changes needed.

## Measurements

Fill in per command.

| Measurement                               | `branches delete` | `secrets set` | `branches get` |
| ----------------------------------------- | ----------------- | ------------- | -------------- |
| Annotation lines added                    |                   |               |                |
| Handler lines changed                     |                   |               |                |
| Guarded client lines (shared, count once) |                   |               |                |
| Mistakes caught at compile time           |                   |               |                |
| Mistakes caught at runtime or in tests    |                   |               |                |
| Mistakes missed                           |                   |               |                |
| Startup change, full tree                 |                   |               |                |

## Findings

- The contract's `configuration` references the two canonical ways of reading a configurable value: `configKeys` lists `CliConfigKeys` entries (read through `CliConfigValues`, ADR 0032), and `settings` lists `CommandSettings` field names. A config key carries its own env name and flag binding, so the generators read those from the key instead of from the contract.
- Limitation: `settings` isn't checked. `CommandSettings` is one service, so `R` can't show which of its fields a command reads, and each field's sources (flag, env, file, default) live only in `commandSettingsLayer` code. The `branches delete` list is written by hand. Closing this needs a runtime-settings registry modeled on `CliConfigKeys`, where each field declares its sources and `commandSettingsLayer` resolves from the declarations. That's a separate proposal with its own ADR.
- Tried and reverted: environment variables as `EnvVar` services provided by the root, with `withContract` comparing them to `R`. The check worked (it found `SUPABASE_HOME` and `GITHUB_TOKEN` missing from the hand-written list), but it had three problems. It tracked where values come from rather than which values a command uses, so one value with a flag and an env source needed a hand-written `fallbackFor` link between two lists. It conflicts with `packages/config/docs/cli-config-loading.md` ("Process Env as Input"), which says process env isn't a service. And converting the `SUPABASE_YES` read caused 1,264 type errors across 37 test files that build layers without the root.
- Tried and rejected: a resolved project-ref service in `R`. `ProjectRefResolver` is built inside each command by `managementApiRuntimeLayer` and three other runtime layers, because it needs `Output`, the API client factory and the command's `--remote` value, so the root can't provide it and `withContract` never sees it.

## Decision Log

| Date       | Decision                                                                            | Reason                                                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-06 | Spike on `branches delete`, `secrets set`, `branches get`                           | `branches delete` tests the boundary; the other two cover configuration, variable write counts, docs retirement and output modes that it doesn't.              |
| 2026-11-06 | Contract references `CliConfigKeys` and `CommandSettings` fields; `EnvVar` reverted | Follows the canonical config paths and the documented rule that process env isn't a service; settings stay unchecked until a runtime-settings registry exists. |
