# Supabase CLI Test Plan

## Background

The Supabase CLI has significant stability issues reported by the community ([Reddit discussion](https://www.reddit.com/r/Supabase/comments/1rlzfk9/the_supabase_cli_desperately_needs_a_stable/), [GitHub issues](https://github.com/supabase/cli/issues)). The most common complaints center around database migration tooling (`db diff`, `db push`, `db dump`, `db reset`), container/Docker reliability, configuration parsing, and local development authentication. This plan proposes tests to cover the highest-impact gaps.

---

## 1. Database Migration Tests

### 1.1 `db push` (`internal/db/push/`)

**Existing coverage:** dry run, successful push, connection failures, missing roles/seeds, user cancellation.

**New tests needed:**

| Test | Description | Why |
|------|-------------|-----|
| `TestPushWithMissingSeedFiles` | `db push --include-seed` when seed files referenced in config don't exist on disk | [#4907](https://github.com/supabase/cli/issues/4907) - seed files silently skipped |
| `TestPushWithMissingConfigFile` | `db push` when `config.toml` is absent or malformed | [#4949](https://github.com/supabase/cli/issues/4949) - push fails without clear error |
| `TestPushMigrationTimestampConflict` | Two migrations with identical timestamps | [#4406](https://github.com/supabase/cli/issues/4406) - causes re-runs |
| `TestPushPartialFailureRollback` | First migration succeeds, second fails — verify first is not committed | Ensures transactional safety |
| `TestPushWithAtomicColumnNames` | Table/column names containing the word "atomic" | [#4746](https://github.com/supabase/cli/issues/4746) - breaks migration parsing |
| `TestPushConcurrentExecution` | Two `db push` calls running simultaneously | Ensure proper locking/error messaging |
| `TestPushLargeMigrationFile` | Migration file >10MB with many statements | Performance and memory safety |

### 1.2 `db pull` (`internal/db/pull/`)

**Existing coverage:** remote schema dump, diff failures, sync validation, permission denied.

**New tests needed:**

| Test | Description | Why |
|------|-------------|-----|
| `TestPullWithManagedSchemas` | Pull when managed schemas (auth, storage, etc.) are included | Code has TODO for this |
| `TestPullWithDeclarativeSchemas` | Pull when `schema_paths` are configured in config.toml | [#39213](https://github.com/orgs/supabase/discussions/39213) - sync issues |
| `TestPullMigrationVersionFormatParsing` | Various version string formats (numeric, prefixed, padded) | [#4758](https://github.com/supabase/cli/issues/4758) - parsing failures |
| `TestPullNetworkTimeout` | Network drops mid-transfer during schema dump | Error recovery |
| `TestPullEmptyRemoteSchema` | Pull from a database with no user-created objects | Edge case |

### 1.3 `db diff` (`internal/db/diff/`)

**Existing coverage:** shadow database, timeouts, permission denied, Docker integration.

**New tests needed:**

| Test | Description | Why |
|------|-------------|-----|
| `TestDiffGeneratesPerpetualGrants` | Diff produces GRANT statements on every run even with no changes | [#4902](https://github.com/supabase/cli/issues/4902), [#3739](https://github.com/supabase/cli/issues/3739) |
| `TestDiffPartitionedTables` | Diff with partitioned tables produces correct FK constraints | [#4562](https://github.com/supabase/cli/issues/4562) - generates 350 duplicate FKs |
| `TestDiffDeclarativeMissingAuthTriggers` | Declarative schema mode omits auth triggers | [#3974](https://github.com/supabase/cli/issues/3974) |
| `TestDiffLinkedShadowDatabaseMacOS` | `db diff --linked` shadow database startup on macOS | [#3700](https://github.com/supabase/cli/issues/3700) |
| `TestDiffIdempotent` | Running diff twice with no changes produces empty output | Stability check |
| `TestDiffDropStatementWarning` | Diff output containing DROP statements triggers user warning | Safety feature validation |

### 1.4 `db dump` (`internal/db/dump/`)

**Existing coverage:** remote dump, stdout, Docker errors, permission denied.

**New tests needed:**

| Test | Description | Why |
|------|-------------|-----|
| `TestDumpGeneratedColumns` | Dump with generated columns produces valid SQL | [#3921](https://github.com/supabase/cli/issues/3921) |
| `TestDumpPasswordErrors` | Wrong password handling and error messages | [#2325](https://github.com/supabase/cli/issues/2325) - long-standing issue |
| `TestDumpCloudFrontErrors` | Handle CDN/network errors gracefully | [#4869](https://github.com/supabase/cli/issues/4869) |
| `TestDumpLargeSchema` | Dump of a schema with 500+ tables | Performance |

### 1.5 `db reset` (`internal/db/reset/`)

**Existing coverage:** storage seeding, context cancellation, database recreation, service restart, health checks.

**New tests needed:**

| Test | Description | Why |
|------|-------------|-----|
| `TestResetDoesNotBrickEnvironment` | Reset completes without leaving database in broken state | [#4522](https://github.com/supabase/cli/issues/4522) |
| `TestResetWithCorruptedMigration` | Reset when a migration file is syntactically invalid | Error reporting |
| `TestResetPreservesRoles` | Verify custom roles are recreated after reset | Data integrity |
| `TestResetWithVersionFlag` | `db reset --version <timestamp>` applies migrations up to that point | Feature correctness |

---

## 2. Configuration Parsing Tests (`pkg/config/`)

**Existing coverage:** basic parsing, env vars, remote overrides, file size limits, JWT, hooks, globs.

**New tests needed:**

| Test | File | Description | Why |
|------|------|-------------|-----|
| `TestConfigMalformedToml` | `config_test.go` | Malformed TOML syntax (unclosed brackets, missing quotes) | Graceful error messages |
| `TestConfigUnrecognizedKeys` | `config_test.go` | Unknown keys in config.toml | [#39213](https://github.com/orgs/supabase/discussions/39213) - "unrecognised key" errors |
| `TestConfigMajorVersionValidation` | `db_test.go` | `major_version = 15` or `17` depending on support | [#10975](https://github.com/orgs/supabase/discussions/10975), [#3748](https://github.com/supabase/cli/issues/3748) |
| `TestConfigEnvVarMissing` | `config_test.go` | `${MISSING_VAR}` in config without env var set | Clear error vs silent empty string |
| `TestConfigEnvVarInjection` | `config_test.go` | `${VAR}` with shell metacharacters in value | Security: no command injection |
| `TestConfigConflictingPoolerSettings` | `db_test.go` | Pooler enabled with conflicting mode/port | Validation |
| `TestConfigStorageBucketValidation` | `storage_test.go` | Invalid bucket names, conflicting settings | [Storage issues](https://github.com/supabase/cli/issues/4941) |
| `TestConfigMultipleAuthProviders` | `auth_test.go` | Multiple OAuth providers configured simultaneously | Correctness |
| `TestConfigPathTraversal` | `config_test.go` | `seed_paths = ["../../../etc/passwd"]` | Security |
| `TestConfigDotInProjectId` | `config_test.go` | Project ID containing dots | [#4767](https://github.com/supabase/cli/issues/4767) - silent failures |
| `TestConfigRemoteLocalDiffDetection` | `config_test.go` | Detect actual vs false-positive config differences | [#2539](https://github.com/supabase/cli/issues/2539) |

---

## 3. Container / Docker Tests (`internal/db/start/`, `internal/start/`)

**Existing coverage:** main branch init, backup recovery, start failures, custom settings, DB version differences.

**New tests needed:**

| Test | Description | Why |
|------|-------------|-----|
| `TestStartContainerHealthCheck` | Verify all containers reach healthy state before returning | [#4756](https://github.com/supabase/cli/issues/4756) - "not healthy" status |
| `TestStartAfterStopReuse` | `stop` then `start` doesn't get "already in use" errors | [#4769](https://github.com/supabase/cli/issues/4769) |
| `TestStartImagePullFailure` | Handle Docker image pull failures gracefully | [#4712](https://github.com/supabase/cli/issues/4712), [#4696](https://github.com/supabase/cli/issues/4696) |
| `TestStartARMPlatform` | Correct image selection on ARM/Apple Silicon | [#4779](https://github.com/supabase/cli/issues/4779) |
| `TestStartStorageContainerHealth` | Storage container specifically reaches healthy state | [#4941](https://github.com/supabase/cli/issues/4941) |
| `TestStartWithExcludeFlag` | `start --exclude` properly skips containers | Feature correctness |
| `TestStartDotInProjectId` | Project with dots in ID starts without error | [#4767](https://github.com/supabase/cli/issues/4767) |
| `TestStopCleanup` | `stop` removes all containers and networks cleanly | Resource cleanup |

---

## 4. Migration Management Tests (`pkg/migration/`, `internal/migration/`)

### 4.1 Migration Application (`pkg/migration/apply.go`)

| Test | Description | Why |
|------|-------------|-----|
| `TestApplyMigrationWithResetAll` | Verify `RESET ALL` runs between migrations | Connection state isolation |
| `TestApplyMigrationPartialFailure` | Failure mid-batch does not corrupt migration history | Data integrity |
| `TestApplyMigrationEmptyFile` | Empty `.sql` file is handled gracefully | Edge case |
| `TestApplyMigrationSQLInjectionInFilename` | Migration filename with SQL injection characters | Security |

### 4.2 Migration Fetch (`internal/migration/fetch/`) — **NO EXISTING TESTS**

| Test | Description | Why |
|------|-------------|-----|
| `TestFetchRemoteMigrations` | Successfully fetches migrations from remote history table | Basic functionality |
| `TestFetchNetworkFailure` | Network error during fetch | Error handling |
| `TestFetchEmptyHistory` | No migrations in remote history | Edge case |
| `TestFetchMismatchedVersions` | Remote versions don't match local versions | Conflict detection |

### 4.3 Migration Squash (`internal/migration/squash/`)

| Test | Description | Why |
|------|-------------|-----|
| `TestSquashPreservesSemantics` | Squashed migration produces same schema as individual ones | Correctness |
| `TestSquashWithDependencies` | Migrations with cross-references squash correctly | Ordering |

### 4.4 Migration Down (`internal/migration/down/`)

| Test | Description | Why |
|------|-------------|-----|
| `TestDownLastN` | Rolling back last N migrations | Feature correctness |
| `TestDownWithNoMigrations` | Rollback when no migrations have been applied | Edge case |
| `TestDownPartialFailure` | Failure during rollback leaves clean state | Data integrity |

---

## 5. Project Link Tests (`internal/link/`)

**Existing coverage:** linking, service config, postgrest, database settings, storage migration, version sync.

**New tests needed:**

| Test | Description | Why |
|------|-------------|-----|
| `TestLinkIntermittentFailure` | Network flakiness during link | [#4419](https://github.com/supabase/cli/issues/4419) |
| `TestLinkFalseConfigDiff` | Link warns about config differences that don't exist | [#2539](https://github.com/supabase/cli/issues/2539) |
| `TestLinkVersionMismatch` | Local PG version differs from remote | [#3748](https://github.com/supabase/cli/issues/3748) |
| `TestLinkStatusCorrectURL` | `supabase status` returns correct database URL after link | [#4326](https://github.com/supabase/cli/issues/4326) |

---

## 6. Edge Functions Tests (`internal/functions/`)

| Test | Description | Why |
|------|-------------|-----|
| `TestDeployReadNpmrcEnvVars` | Deploy reads `.npmrc` environment variables | [#4927](https://github.com/supabase/cli/issues/4927) |
| `TestServe502BadGateway` | `functions serve` doesn't produce 502 errors | [#4757](https://github.com/supabase/cli/issues/4757) |
| `TestDeleteSlugWithSlashes` | Deleting function slugs containing `/` | [#4896](https://github.com/supabase/cli/issues/4896) |
| `TestSingleTestFileWithIncludes` | Running a single test file that imports another file | [#4850](https://github.com/supabase/cli/issues/4850) |

---

## 7. Authentication / Local Dev Tests

| Test | Description | Why |
|------|-------------|-----|
| `TestJWTSigningKeysLocalDev` | JWT signing keys work correctly in local development | [#4098](https://github.com/supabase/cli/issues/4098) |
| `TestSecretKeyLocalCompatibility` | Secret key format compatible with local dev | [#4524](https://github.com/supabase/cli/issues/4524) |
| `TestPublishableKeyRealtime` | Publishable key doesn't break realtime subscriptions | [#4219](https://github.com/supabase/cli/issues/4219) |

---

## 8. SQL Parser Tests (`pkg/parser/`)

| Test | Description | Why |
|------|-------------|-----|
| `TestParserAtomicKeyword` | SQL containing the word "atomic" in identifiers | [#4746](https://github.com/supabase/cli/issues/4746) |
| `TestParserLargeStatement` | SQL statement >1MB | Performance/memory |
| `TestParserMultilineDollarQuoting` | `$$` dollar-quoted strings with newlines | Correctness |
| `TestParserCommentedOutStatements` | SQL with `--` and `/* */` comments | Edge case |

---

## 9. End-to-End Integration Tests

These require Docker and should run in CI with the existing e2e infrastructure.

| Test | Description | Why |
|------|-------------|-----|
| `TestE2EInitPushPullCycle` | `init` -> create migration -> `start` -> `push` -> `pull` -> verify schema matches | Full workflow |
| `TestE2EMigrationSquashAndPush` | Create 5 migrations -> squash -> push -> verify schema | Squash correctness |
| `TestE2EResetAndReseed` | `start` -> seed -> `reset` -> verify seed data restored | Reset reliability |
| `TestE2EConfigChangeAndRestart` | Modify `config.toml` -> `stop` -> `start` -> verify new config applied | Config reload |
| `TestE2EDiffAfterManualChange` | `start` -> manually alter schema -> `diff` -> apply diff -> verify idempotent | Diff accuracy |
| `TestE2ELinkAndPush` | `link` to remote project -> `push` migrations | Remote workflow |

---

## Implementation Priority

### Phase 1 — Critical (address most-reported bugs)
1. `db diff` perpetual grants and partitioned table tests (Section 1.3)
2. `db push` seed file and timestamp conflict tests (Section 1.1)
3. Config parsing validation tests (Section 2)
4. SQL parser "atomic" keyword test (Section 8)

### Phase 2 — High (fill major coverage gaps)
5. Migration fetch tests — no existing tests at all (Section 4.2)
6. Container health check and start/stop tests (Section 3)
7. `db dump` generated columns and password errors (Section 1.4)
8. `db reset` environment bricking prevention (Section 1.5)

### Phase 3 — Medium (improve robustness)
9. Project link false-positive diff tests (Section 5)
10. Edge functions deployment tests (Section 6)
11. Migration down/squash edge cases (Section 4.3, 4.4)
12. E2E integration tests (Section 9)

### Phase 4 — Hardening
13. Authentication / JWT local dev tests (Section 7)
14. Large file / performance tests
15. Concurrent operation tests
16. Security edge cases (path traversal, injection)

---

## Test Infrastructure Recommendations

1. **Use existing mock infrastructure** — The project already has `pgtest`, `apitest`, `fstest`, and `gock` for HTTP mocking. New unit tests should follow these patterns.

2. **Add table-driven tests** — Go's `t.Run()` with table-driven subtests for config validation and parser tests to cover many edge cases concisely.

3. **Add test fixtures** — Create `testdata/` directories with sample malformed configs, large SQL files, and edge-case migration files.

4. **Tag e2e tests** — Use build tags (`//go:build e2e`) so integration tests don't run in unit test CI jobs.

5. **Fuzz testing** — Add `func FuzzConfigParse(f *testing.F)` and `func FuzzSQLParser(f *testing.F)` for config and SQL parsing using Go's built-in fuzzing.
