# Command Contract Spike

Plan for the spike of a command contract for the Supabase CLI.

Status values: `not started`, `in progress`, `blocked`, `done`, `dropped`.

Status: in progress

## Goal

Annotate three commands fully, generate their help, docs-spec entry and `describe` JSON from the annotations, and check their Management API calls at a boundary. The measurements answer the RFC's open question: declarations only, a typed client per command, or the full boundary.

Nothing merges to `develop` until the spike is reviewed.

## Candidates

| Command           | Order | What it tests                                                                                                                                                                                                                         | Bad at                                                                       |
| ----------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `branches delete` | 1     | Management API boundary; delete target from input (20-letter ref) or from a lookup (name or UUID); operations composed from shared blocks                                                                                             | Small output, no `config.toml`, a single write, no hand-kept docs to retire  |
| `secrets set`     | 2     | Write cap that depends on input (ceil(n/100) batches); retiring hand-kept docs; secret values kept out of `describe`, docs and errors. Picked first for configuration, which is now out of scope (see Prerequisite for Configuration) | 335-line handler with config recovery, so boundary cost is harder to isolate |
| `branches get`    | 3     | Output declaration across `-o` formats and `--output-format`; operations that depend on flags (`MACHINE_OUTPUT` in `get.command.ts`); masked sensitive fields                                                                         | Read-only, so no write checks; same family as `branches delete`              |

Rejected: `config push` (731-line handler plus 1,628 lines of encoders hide the boundary cost), `branches list` (`branches get` covers its output modes), commands that reach Docker, Postgres or the filesystem (outside the Management API boundary).

## Shared Work

- [x] Define the annotations other than configuration on Effect CLI commands (`Command.annotate`, read with `Context.getOption`), building on `withPermissions`.
- [x] Guarded Management API client: matches each request to an operation, checks the declared target, counts writes, refuses unknown requests. `ManagementApiGuard` (`apps/cli/src/command-internal/command-contract/management-api-guard.ts`) wraps the client in `makeCommandPlatformApi`; `withContract` provides it per run. Prompt answers count as input through a wrapped `Output`.
- [ ] Remove the raw `HttpClient.HttpClient` from `ManagementApiServices` (`apps/cli/src/command-internal/management-api-runtime.layer.ts:112-123`) so an undeclared call fails to compile.
- [ ] (Partly: `branches delete` guard tests build the real client under the guard; other tests still call handlers without it.) Run the guarded client over `mockCommandPlatformApi` (`apps/cli/tests/helpers/command-mocks.ts:562`) so the runtime checks run in integration tests.
- [ ] Generators: `--help`, the docs-spec entry and a `describe` JSON, each read from annotations alone.
- [ ] Decide how the filesystem side writes (`linked-project.json`, `telemetry.json`) are declared, or record them as out of scope for this boundary.
- [ ] Measure startup across the full command tree with the annotations loaded.

## `branches delete`

Status: in progress. Contract annotated (`apps/cli/src/commands/branches/delete/delete.contract.ts`); reads stay in `withPermissions`.

- [x] Annotate the five declarations other than configuration.
- [ ] Generate `--help`, docs-spec entry and `describe` JSON; diff against current output.
- [x] Route API calls through the guarded client.
- [ ] Tests that must fail: undeclared operation (compile time), delete of an ID the lookup didn't return, a second delete, an unmatched request. Runtime refusals of an undeclared operation, an unsourced target and a second delete are covered; an unmatched request is not. The compile-time check is deferred to SDK generation (see below).
- [ ] Record handler changes needed.

## `secrets set`

Status: in progress. Contract annotated (`apps/cli/src/commands/secrets/set/set.contract.ts`); `writes` left empty.

- The compile check found 33 undeclared errors on the first pass with `errors: []`, including six `LinkBranch*` errors from `branchResolution` and five config-load errors.
- The handler reads `[edge_runtime.secrets]` as a subtree through `resolveCliSubtree`, and the registry has no key for `edge_runtime.secrets` or any `remotes.*` path. A contract can't name a subtree read with `CliConfigKey` references; table keys in the Prerequisite for Configuration would cover it.
- `writes` can't express the cap: `max` is a number, and the handler sends ceil(n/100) `v1-bulk-create-secrets` batches.

- [ ] Annotate the five declarations other than configuration.
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

- Configuration is out of the contract for now. An earlier version had `configKeys` (`CliConfigKeys` references) and `settings` (`CommandSettings` field names), but nothing checked either list, and a check that runs only in tests doesn't meet the contract's premise: agents can edit tests to get green, so only compile-time checks count. The prerequisite is recorded below.
- Tried and reverted: environment variables as `EnvVar` services provided by the root, with `withContract` comparing them to `R`. The check worked (it found `SUPABASE_HOME` and `GITHUB_TOKEN` missing from the hand-written list), but it had three problems. It tracked where values come from rather than which values a command uses, so one value with a flag and an env source needed a hand-written `fallbackFor` link between two lists. It conflicts with `packages/config/docs/cli-config-loading.md` ("Process Env as Input"), which says process env isn't a service. And converting the `SUPABASE_YES` read caused 1,264 type errors across 37 test files that build layers without the root.
- Tried and rejected: a resolved project-ref service in `R`. `ProjectRefResolver` is built inside each command by `managementApiRuntimeLayer` and three other runtime layers, because it needs `Output`, the API client factory and the command's `--remote` value, so the root can't provide it and `withContract` never sees it.
- `configKeys` probe on `db reset` (not annotated). Logging `ResolvedCliConfig.get` during its 145 integration tests recorded nine keys: `project_id`, `db.seed.sql_paths`, `db.seed.enabled`, `db.password`, `db.migrations.schema_paths`, `db.root_key`, `experimental.pgdelta.enabled`, `auth.passkey.enabled`, `auth.external_url`, plus `linkedDb.password` on the linked path. The command file names two of them (through `key.flag`); the rest are read in shared helpers (`apps/cli/src/command-internal/db-config.read.ts`, `planDbSeed`, the local reset composition). The same helpers also read values straight off the decoded config (`config.db.seed.enabled`, `config.api.schemas`, `config.api.enabled`), which no `get` log sees. A hand-written `configKeys` list would drift as the helpers change, and a test-recorded one would be incomplete.
- `db reset` without a contract would need 92 declared errors and eight global flags (including `experimental` and `network-id`); most errors come from shared Docker, storage and db-config code.

## Prerequisite for Configuration

Configuration can join the contract once every config and settings read goes through a key the compiler can see.

- **Mechanism (probed).** Each read adds a type-level requirement `Reads<K>` to the effect's `R`. `withContract` provides exactly the declared keys, so an undeclared read leaves a requirement behind and fails to compile; a declared key nothing reads fails the same equality check `GlobalFlagCheck` uses. The root and the test runtime helpers provide a `Reads<string>` wildcard, which satisfies every `Reads<K>`, so commands without a contract and tests keep compiling. A scratch probe against this repo's Effect version gave `Type 'Effect<void, never, Reads<"profile">>' is not assignable to type 'Effect<void, never, never>'` for an undeclared read, and compiled with both keys provided or with the wildcard.
- **The accessor needs one cast.** The wildcard can't stand in for a keyed service at runtime, so the accessor adds `Reads<K>` to `R` without a real lookup. That's one cast in one module, with a lint-disable reason.
- **Prerequisite work.** A `CliSettingKeys` registry that declares each runtime setting's sources (flag, env, file, default), which removes the need for links like `fallbackFor`. Table keys (``Reads<`auth.${string}`>``) for code that consumes whole sections: `start`, `config push`, `[remotes.*]`, `[edge_runtime.secrets]`. No command access to the decoded config object or to `CommandSettings` fields, enforced by the types or by lint with an allowlist during migration.
- **Scale.** About 150 files: 39 files with roughly 318 reads off the decoded config object, 110 files reading `CommandSettings`, and 10 already reading through `.get(CliConfigKeys...)` (rough greps over `apps/cli/src`, tests excluded).
- **Ownership.** It overlaps ADR 0032 and the existing config work, so it's a separate proposal.
- **Untested.** Whether template-literal table keys behave like the wildcard, and type-check time with long `Reads` unions.

## Prerequisite for the Boundary

The boundary needs every Management API request a command makes to go through one client, so the runtime guard has one insertion point and the compile-time check has one type to tag.

- **Done for `branches delete`.** It used two clients: `CommandPlatformApi` (the handler, `branchPrompt`, `branchRef` and, through `commandPlatformApiFactoryFromApiLayer`, `projectRefPicker`) and a client `LinkedProjectCache` built for itself on a separate `HttpClient`. `LinkedProjectCache` now uses the command's lazy `CommandPlatformApiFactory` and still skips quietly when no access token resolves. Every runtime layer that provides the cache now provides the factory too.
- **Left: the `sso` profile override.** `sso add` and `sso update` pass a reconciled profile (`LinkedProjectCacheProfile`, with its own API URL and token) to `cache(...)`, and the cache builds a separate client for it, because the factory can't take a profile. The fix is a factory that accepts a profile.
- **Left: raw `HttpClient` callers.** Sixteen non-test files take `HttpClient` directly (for example `apps/cli/src/commands/domains/create/create.handler.ts` and `apps/cli/src/shared/services/services.shared.ts`). Not yet audited for which ones call the Management API rather than other hosts.

## Compile-Time Operation Checks

The full implementation moves to the SDK generation work, because most of its blast radius is generator output. Until then the runtime guard enforces declared operations for commands with a contract.

- **Probed.** `apps/cli/src/command-internal/command-contract/management-api-operation-types.unit.test.ts` types each client method as requiring `ApiOperation<Id>`, where `Id` is the spec's operation id derived from `openApiOperationIdMap`. Providing the declared union removes those requirements, so an undeclared call fails to compile with `Property 'undeclaredOperations' is missing ... { readonly undeclaredOperations: "supabase/api/operation/v1-list-all-organizations"; }`. All 225 generated methods map to an operation id, a typo in a declared id fails against the spec's ids, and the probe adds about 0.3% to the CLI's type instantiations.
- **Not probed.** The check inside `withContract` on a real handler, and a contract with dozens of operations.

Requirements for SDK generation:

- **Operation in `R`.** Each generated method returns `Effect<Output, Error, ApiOperation<Id>>` and yields that service at runtime, so the requirement is real and needs no cast.
- **Raw requests.** `executeRaw` (17 non-test callers) takes an operation id, or its calls stay runtime-only.
- **Shared services.** Services such as `LinkedProjectCache` call the client inside their implementation and expose `R = never`, so their operations never reach the command. Decide whether service signatures carry `ApiOperation` requirements or leave those calls to the runtime guard.
- **Commands without a contract.** The root and test runtime helpers provide an allow-all `ApiOperation`, the same wildcard approach as `Reads<string>`, so the 87 files that use the client keep compiling.
- **Literal declarations.** `OperationEntry.operationId` (`apps/cli/src/command-internal/command-permissions/model.ts:78`) becomes the spec's id union, and `block`/`compose` keep literal ids in their types so `withContract` can provide the declared union.

## Open Questions

- How should shared code contribute its errors to a contract? The declared lists grow with the shared code a command composes, not with what the command does: 36 errors for `branches delete`, 41 for `secrets set` and 92 for `db reset`. Repeating them in every contract makes them the bulk of each declaration and copies the compiler's output by hand. One option is error fragments contributed by shared code and combined per command, the way permissions use `block(...)` and `compose(...)`; the compile-time check would then compare `E` against the composed list. Settle this before annotating a third command.

## Decision Log

| Date       | Decision                                                                                                 | Reason                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-06 | Spike on `branches delete`, `secrets set`, `branches get`                                                | `branches delete` tests the boundary; the other two cover configuration, variable write counts, docs retirement and output modes that it doesn't.                    |
| 2026-11-06 | Contract references `CliConfigKeys` and `CommandSettings` fields; `EnvVar` reverted                      | Follows the canonical config paths and the documented rule that process env isn't a service; settings stay unchecked until a runtime-settings registry exists.       |
| 2026-11-06 | Drop `configuration` from the contract; record the prerequisite                                          | Only compile-time checks count, and a compile-time config check needs every read behind a key first (about 150 files), which is config work outside this POC.        |
| 2026-11-06 | `LinkedProjectCache` uses `CommandPlatformApiFactory`; one client per command is a boundary prerequisite | Gives the guard one insertion point for `branches delete` and the compile-time check one client type; the `sso` override and raw `HttpClient` callers remain.        |
| 2026-11-06 | Defer compile-time operation checks to SDK generation; keep the runtime guard                            | A type probe shows the mechanism works; the rest is generator output (typed methods, `executeRaw`, the 87-file client swap) that a CLI-side wrapper would duplicate. |
