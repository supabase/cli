# Go CLI Divergences

Ledger of deliberate TypeScript divergences from the old Go CLI (pre-`7b469f5b3`) on the legacy
shell: TS-only commands, flags, and behavior with no Go counterpart. When you add a TS-only flag or
a deliberate behavioral change to an already-ported legacy command, add an entry here in the same
change. This document exists to answer support and migration questions about why the TS CLI does
something the old Go CLI didn't — it is not a compatibility promise.

## TS-only Commands

These commands exist in the TS CLI today but have no direct top-level equivalent in the old Go CLI reference.

| TS command        | TS path                                                                                                            | Notes                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev`             | `planned`                                                                                                          | Reserved for a TS-native long-running local development workflow command that watches files and orchestrates subcommands. Track this as TS-only unless a direct Go equivalent emerges.        |
| `logs`            | [`../src/next/commands/logs/logs.command.ts`](../src/next/commands/logs/logs.command.ts)                           | Streams local stack logs. No top-level `logs` command exists in the old Go CLI reference.                                                                                                     |
| `api`             | [`../src/next/commands/platform/api.command.ts`](../src/next/commands/platform/api.command.ts)                     | Low-level Management API client. It supersedes the old generated tree with explicit discovery via `supabase api routes` and execution via `supabase api request <route> [--method <METHOD>]`. |
| `stack`           | [`../src/next/cli/root.ts`](../src/next/cli/root.ts)                                                               | TS-only local runtime namespace exposing `stack start`, `stack stop`, `stack status`, `stack list`, and `stack update`. Top-level `start`, `stop`, and `status` remain aliases.               |
| `branches switch` | [`../src/next/commands/branches/switch/switch.command.ts`](../src/next/commands/branches/switch/switch.command.ts) | No direct Go equivalent. Updates local active-branch state so subsequent commands target the selected branch.                                                                                 |

## Flag divergences from the Go reference

- `db diff`, `db pull`, and `db schema declarative generate`/`sync` have a TS-only
  `--strict-coverage` flag (no Go equivalent). It applies only when the bundled
  pg-delta next engine is active (the default): coverage gaps that the engine
  reports — statements it skipped or objects it could not represent — normally
  surface as warnings, and `--strict-coverage` promotes them to hard failures.
  Under the `SUPABASE_USE_PG_DELTA_NEXT=false` legacy opt-out the flag is
  accepted but has no effect, since the legacy edge-runtime engine does not
  emit coverage diagnostics. Default behavior (omitted flag) matches Go.
- `db push` has a TS-only `--skip-vault` flag. It applies migrations without
  resolving or updating `[db.vault]` secrets; default behavior still matches Go.
- Every legacy command that resolves a linked project ref for its own database
  connection has a TS-only `--project-ref` flag (no Go equivalent on any
  user-facing command — only the `SUPABASE_PROJECT_ID` env var could override
  the linked ref; the sole Go registration is a hidden, non-user-facing seam,
  `db declarative __catalog --project-ref`, `cmd/pgdelta_catalog.go:44`). This
  covers: `db push`, `db pull`, `db diff`, `db dump`, `db reset`, `db lint`,
  `db advisors`, `db query`; `migration list`/`up`/`down`/`repair`/`fetch`/`squash`;
  `seed buckets`; `storage ls`/`cp`/`mv`/`rm`; every `inspect db` subcommand and
  `inspect report`; and `test db` (and its hidden `db test` alias, which shares
  `test db`'s flag config verbatim). It feeds
  `LegacyProjectRefResolver.loadProjectRef`, keeping Go's precedence (flag >
  `SUPABASE_PROJECT_ID` > `supabase/.temp/project-ref`) and taking effect only on
  the linked path. It shares ONLY that ref-resolution precedence with
  `SUPABASE_PROJECT_ID` — unlike the env var, it does not affect the local
  container id or the pg-delta project id, and it does not imply `--linked`:
  passing it alongside `--local`/`--db-url` (or, for `db diff`, in explicit mode
  without `--from`/`--to linked`) is a hard error rather than a silently ignored
  flag, since Go's env var going unused on a non-linked target has no TS-only
  flag counterpart to accidentally discard. Default behavior (omitted flag)
  matches Go exactly.
- `projects api-keys` has a TS-only `--reveal` flag (no Go equivalent). It sends
  `reveal=true` so the Management API returns the full secret keys (`sb_secret_...`) in
  full instead of redacting them, addressing issue #4775. Default behavior (omitted flag)
  matches Go exactly.
- `projects create` has a TS-only `--high-availability` flag (no Go equivalent). It sets
  `high_availability` in the create request body. Default behavior (omitted flag) matches
  Go exactly.
- `projects create` has TS-only `--release-channel` and `--postgres-engine` flags (no Go
  equivalent). They set `release_channel` / `postgres_engine` in the create request body —
  fields the upstream Management API OpenAPI spec deliberately hides even though
  `POST /v1/projects` accepts them (restored via `packages/api/scripts/openapi-overrides.json`,
  CLI-2180). Both flags are hidden and gated behind `--experimental` (or `SUPABASE_EXPERIMENTAL`)
  until PROD-548 exposes them officially; omitting them matches Go exactly.
- `db schema declarative generate` has a TS-only `--output-dir <dir>` flag (no Go equivalent,
  no short alias). It writes the generated declarative tree to the given directory for this
  invocation only, without changing the configured `declarative_schema_path` — the staging step
  of the legacy-tree upgrade recipe printed by the sync/generate compatibility gates. The name
  deliberately avoids `--output`/`-o`, which the legacy root reserves for the global
  machine-format flag; a leaf string flag would shadow it and turn `generate -o json` into a
  write to a directory named `json`. Default behavior (omitted flag) matches Go.
- `link` has a TS-only `[ref-or-branch]` positional argument (no Go equivalent), and its
  `--project-ref` flag additionally accepts a branch name. A value matching the 20-lowercase-letter
  project ref shape is always treated as a ref; any other non-empty value is resolved to its
  parent-project's branch project ref via the Management API before linking proceeds exactly as
  today (CLI-2167). On the 404 (branch) link path, `link` also best-effort maintains
  `linked-project.json`'s PARENT evidence (PR #6168 review, TS-only, no Go equivalent — Go never
  writes this cache for a branch ref at all): a name/UUID-resolved branch link persists its known
  parent ref (a ref-only record when no richer cache exists yet); a raw ref-shaped branch link
  whose existing cache names a different project best-effort correlates the two via one extra
  `listAllBranches` call and deletes the cache on EVERY unverified result — a verified mismatch,
  a timeout, or any transport/status/decode failure (fail-safe: an unverifiable divergent cache is
  untrustworthy). Both are best-effort and never affect `link`'s own outcome — see
  `link/SIDE_EFFECTS.md`.

## Behavioral divergences from the Go reference

- `db schema declarative generate`/`sync` default declarative directory is `supabase/schemas`;
  the old Go CLI reference (pre-`7b469f5b3`) used `supabase/database`. The move aligns the
  default with the product-wide declarative-schemas convention. To keep the upgrade visible,
  both commands print a TS-only warning when `declarative_schema_path` is unset, the new
  default directory is empty, and the former `supabase/database` default still contains `.sql`
  files or an export manifest — telling the user to set
  `declarative_schema_path = "./database"` or move the tree. The warning never changes
  behavior or exit codes; a non-interactive sync still fails with Go's
  "no declarative schema found" message. Inside that directory the bundled (default) pg-delta
  engine writes one directory per schema at the root — `supabase/schemas/public/tables/x.sql` —
  with cluster-level objects under a reserved `supabase/schemas/_cluster/`. The Go reference,
  and the opt-out legacy engine (`SUPABASE_USE_PG_DELTA_NEXT=false`, which runs the pinned
  `[experimental.pgdelta] npm_version` in Edge Runtime), instead nest everything one level
  deeper as `schemas/<schema>/…` plus `cluster/…`, so a legacy-engine export lands at
  `supabase/schemas/schemas/public/tables/x.sql`.
- Local `pg_net` presence now converges with `[experimental.webhooks]` instead of being
  installed unconditionally: `db-webhook.sql` no longer creates the extension at container
  init, `supabase start`/`db start` install it (with grants reapplied via the
  `issue_pg_net_access` event trigger) only when webhooks are enabled or migration history
  contains a `create extension … pg_net`, and an existing-volume `start` with webhooks
  disabled drops a `pg_net` that migration history does not own. Known accepted edge: `pg_net`
  installed OUTSIDE migrations (for example via local Studio's SQL editor or extension toggle)
  is invisible to the migration-ownership heuristic and is dropped on the next `start`; a
  tracked dependency on `net.*` (PG14+ `BEGIN ATOMIC` functions) makes that non-`CASCADE` drop
  — and therefore `start` — fail. Workaround in both cases: enable `[experimental.webhooks]`
  or declare the extension in a migration. Documented rather than special-cased.
- `test db` (and its `db test` alias) exits `1` when `pg_prove` ran no tests (CLI-2194, #6206).
  `pg_prove` prints `Result: NOTESTS` and still exits `0` for an empty run, and Go returns that
  code verbatim (`internal/db/test/test.go` → `DockerRunOnceWithConfig`), so a typo'd path, an
  empty tests directory, or a bind the daemon resolved against a different filesystem than the
  CLI's (a sibling-container Docker socket) all reported a green build that ran zero tests. The
  TAP stream on stdout is unchanged; the diagnostic goes to stderr like every other failure.
- SQL file runners on a stepped-down session re-assert `SET SESSION ROLE postgres`
  immediately after each top-level role revert (`RESET ROLE`, the generic-`SET` spellings
  such as `SET ROLE [TO|=] NONE|DEFAULT` and a case-sensitively quoted `'none'`,
  `RESET SESSION AUTHORIZATION`, `SET SESSION AUTHORIZATION DEFAULT`, `DISCARD ALL`),
  at the end of each file, and before the migration history insert and the `seed_files`
  upsert — so the whole file (including a post-reset `granted by current_user` cleanup),
  every CLI-owned ledger write, and every subsequent file run as `postgres`, matching a
  password session for `current_user` and privilege checks (CLI-2205, #6236).
  `session_user` remains the login role and `current_setting('role')` reads `postgres`
  rather than `none`, so a file keying on `session_user` still diverges. A stepped-down
  session is any remote connection authenticating as `cli_login_*` (the passwordless
  linked path) or `supabase_admin`, which steps down with a session-level
  `SET SESSION ROLE postgres`; a file's own `RESET ROLE` reverted it to the login role,
  so the appended history insert failed with SQLSTATE 42501 and any later file ran as
  the login role. The old Go CLI had the same defect; on a `supabase_admin` `--db-url`,
  `RESET ROLE` consequently no longer re-escalates to superuser mid-file.
  Statement-level re-assertion is used because a connection-time `role=postgres` default
  cannot be guaranteed through the pooler. Injected restores never shift
  `At statement: N` and are never recorded in the history row. Residual: a role revert
  issued through dynamic SQL, or a spelling outside the list above (for example
  `SET LOCAL ROLE NONE` — deliberately unmatched, a session-scoped restore would
  override its transaction scope — or the `session_authorization` GUC spellings), is
  invisible to the lexical check, so statements after it run as the login role until
  the next restore point; the end-of-file restore still protects every CLI-owned write.
  (`RESET ALL` needs no entry — `role` carries `GUC_NO_RESET_ALL`.)
- `functions serve` per-function env discovery (CLI-2184, #6179): without `--env-file`, each
  `supabase/functions/<function-name>/.env` overrides matching values from the shared
  `supabase/functions/.env` for that Function only; an explicit `--env-file` remains the
  highest-priority source and disables both automatic reads. TS-only feature — the old Go
  command read only the shared fallback.
- `functions deploy`/`functions serve` import-map resolution follows the import-maps spec
  (implemented by Deno): a key matches exactly, or as a prefix only when it ends with `/`. The
  old Go walker prefix-matched every key (`pkg/function/deno.go:150-155`, still in-tree), which
  fabricated paths the runtime could never resolve — the ENOTDIR crash family fixed in
  PR #6164 (CLI-2179). Intentional divergence: the spec behavior is the correct one.
- `config push`/`start` auth email `content_path` resolution: every relative
  `[auth.email.template.*]` AND `[auth.email.notification.*]` path resolves from the discovered
  project root, with notifications additionally falling back to the legacy `supabase/`-relative
  location when the root-resolved file is missing. Go resolves notifications from `supabase/` only
  (`(*baseConfig).resolve`'s own `// FIXME`-flagged asymmetry). Config validation, `config push`
  content loading, and Kong's template mount builder all share one resolver
  (`legacyResolveNotificationContentPath`), so every consumer reads the SAME file — the drift the
  asymmetry caused (validated against `<root>/supabase/...`, mounted from `<root>/...`) is gone.
  The `init` scaffold ejects the root-relative form, which is incompatible with Go if uncommented
  (#6159/#6160).
- `db remote changes|commit --password <p>`: since CLI-1970, an explicit
  `--password` beats the `SUPABASE_DB_PASSWORD` env var. Before the trim, Go's
  package-wide "last `viper.BindPFlag("DB_PASSWORD", …)` wins" behavior bound
  the key to `projects create --db-password` (lexically last `cmd/*.go` file),
  so `db remote`'s own `--password` flag was never the bound instance and env
  silently won over it — a latent bug. With `projects.go` deleted, the bind
  lands on `db remote`'s persistent `--password` and flag-beats-env applies as
  intended. Accepted (not restored) in the CLI-1970 parity audit; `db pull`
  keeps the old precedence (env wins over its `--password`) unchanged.
- `branches {list,create,get,update,delete,pause,unpause,disable}` resolve their project ref
  through a PARENT-scoped chain instead of plain `--project-ref` flag/env/file resolution: an
  explicit `--project-ref` still wins outright, but the fallback is env `SUPABASE_PROJECT_ID` →
  `supabase/.temp/linked-project.json`'s `ref` → `supabase/.temp/project-ref`, first ref-shaped
  candidate wins. This is a direct consequence of the `link` branch-name divergence above: after
  `supabase link <branch>`, `project-ref` holds the branch's own ref, and the Management API
  returns 403 for a branch ref on every branches-management endpoint. No-op when linked to a real
  (non-branch) project — the cache and the file hold the same ref — so this only changes behavior
  in the previously-403ing branch-linked state (CLI-2167 follow-up, no Go equivalent).
- `branches list`'s pretty table (not `-o json|yaml|toml`, not `--output-format json|stream-json`)
  marks the row matching the CURRENTLY linked ref with a `<name> (active)` NAME cell, mirroring
  `next/`'s convention. TS-only QoL, no Go equivalent (CLI-2167 follow-up).
- `status` prints the current linked project/branch as a "Linked Project:" block on stdout in
  human text mode (Neon-style — `Org:`/`Project:`/`Branch:` lines, each omitted when unknown),
  before any daemon/stack work begins, and folds the same linked state into its machine-readable
  outputs — additive `linked_project: {...} | null` (with `org_slug`/`org_id`) in the TS
  `--output-format json`/`stream-json` payload, and additive `linked_project_ref`/
  `linked_project_name`/`linked_org_slug`/`linked_org_id`/`linked_branch`/
  `linked_parent_project_ref` keys (absent entirely when not linked) appended after the existing
  keys in `-o env|json|yaml|toml`. A confirmed branch-linked state (from `linked-project.json`)
  keeps showing the parent/org fields even when the branch-name lookup itself degrades (no
  token, offline, API error) — only the branch's own name is ever missing, so the user always
  sees they're on a branch. The Management API client for that lookup is acquired lazily
  (`LegacyPlatformApiFactory`, not the eager `LegacyPlatformApi`) so `status` stays fully
  functional offline/token-less. Intent: let an agent driving `status` discover which
  project/branch it's on without a separate `link`/`branches` call. Read-only, never affects
  `status`'s exit code, and never alters any of its existing failure behavior — a Docker/daemon
  connection failure still fails exactly as today, with the linked block already printed above it
  in text mode (CLI-2167 follow-up, no Go equivalent). The same `linked_project` object is also
  carried on the `--output-format json`/`stream-json` FAILURE envelope (top-level, next to
  `_tag`/`error` or `type`/`error`/`timestamp`) — the agent-discovery use case matters most when
  `status` fails to reach a stopped stack — via a new opt-in, shared mechanism
  (`shared/output/machine-error-context.service.ts`'s `MachineErrorContext`, read by
  `jsonOutputLayer`/`streamJsonOutputLayer`'s `fail`); `-o env|json|yaml|toml`'s failure output is
  deliberately unchanged (still no payload, matching Go). See `status/SIDE_EFFECTS.md`.
- `projects list`'s `LINKED` marker (the `linked` boolean, rendered as the pretty table's `●`
  bullet) now falls back to the PARENT chain when the linked ref matches no row exactly — the same
  scenario as above, since a branch-linked ref never matches a real project row. **This changes
  the `linked` field in the `-o json|yaml|toml` Go-struct payloads too**: in the branch-linked
  state it was previously `false` on every row; it can now be `true` on the parent project's row.
  The truthful fix IS the behavior change (CLI-2167 follow-up, no Go equivalent).
- `services` warns on a malformed linked project ref (matching Go's
  `flags.LoadProjectRef` validation message) but, unlike Go, does not then use
  that ref for the remote lookup. Go's `cmd/services.go` (deleted in CLI-1970;
  last present at commit 7b469f5b3) treats the validation failure as
  non-fatal and still calls `listRemoteImages` with the malformed
  value; TS skips the remote lookup instead, since the ref is embedded
  unescaped into the tenant gateway hostname and a malformed value could
  redirect the service-role key to an attacker-controlled host. Intentional
  TS-only hardening, not a parity bug — see
  [`services/SIDE_EFFECTS.md`](../src/legacy/commands/services/SIDE_EFFECTS.md).
- `db pull` in-sync (`"No schema changes found"`) keeps Go's message and its non-zero
  exit code, but replaces the generic "Try rerunning the command with --debug to
  troubleshoot the error." stderr footer with an explanatory suggestion line
  ("The remote database is already in sync with your local migrations — nothing to
  pull."). An in-sync database is a finding, not a failure to troubleshoot, so the
  debug hint sent users chasing a non-existent bug. Message text and exit code — the
  parts scripts depend on — are unchanged.
- Edge Runtime's Docker container `--ulimit nofile` value (`functions serve` and `start`): Go
  hardcodes `nofile=65536:65536`, raised from the daemon default to accommodate FD usage from
  many concurrent Deno isolates (supabase/cli#5151). TS clamps that value to the host's own hard
  nofile limit on Linux (`@supabase/stack`'s `edgeRuntimeNofileUlimit`, via
  `process.report`'s `userLimits`), so a constrained sandbox (hard cap below 65536) can still start the
  container instead of failing outright (CLI-2220). The CLI process's own limit is used as a
  proxy for the daemon's — exact in the sandboxes this targets, where both share the cap; a
  Linux client more constrained than its daemon (remote `DOCKER_HOST`, mounted socket) just
  gets a smaller fd budget, never a failed start. When the clamp lowers the request, the legacy
  `functions serve`/`start` bring-up warns with the reduced limit. The `@supabase/stack` service
  builder (next-shell `stack start`) applies the same clamp silently: its defs are built without
  an output channel, and in managed mode inside the daemon process, so a user-visible warning
  there needs a diagnostics channel on `BuildResult` first; the applied value stays visible via
  `docker inspect`.
