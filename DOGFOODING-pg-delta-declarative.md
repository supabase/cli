# Dogfooding report — declarative schemas + pg-delta (CLI `develop`, 2026-08-26)

Session: remote sandbox, CLI run from source (`bun src/legacy/main.ts`, pg-delta bundled
implementation "next", `@supabase/pg-delta` 1.0.0-alpha.46). Docs reference:
[supabase/supabase#49280](https://github.com/supabase/supabase/pull/49280).

## Scope and environment constraints

Full local passes were completed: greenfield declarative flow, iterate/sync loop, error paths,
`generate`/`db pull --declarative`, `db diff` (pg-delta + `--use-migra`), `db pull`/`db push`
via `--db-url` against local Supabase and foreign plain-Postgres databases, schema filtering,
`--strict-coverage`, `_custom/` handling, destructive-change handling, and doc-claim verification.

Two environment blockers (not product bugs, but worth knowing for future dogfooding sessions):

- **The staging token was unusable**: this sandbox's egress policy 403-blocks
  `api.supabase.green` (and `api.supabase.com`). Every `login` / `link` / `--linked` scenario is
  untested. If you want linked-flow dogfooding from Claude sessions, the environment's network
  policy needs those hosts (plus `*.supabase.green` db/pooler hosts) allowlisted.
- Docker Hub/ECR/GHCR blob CDNs are blocked too. Workaround that made everything else possible:
  `SUPABASE_INTERNAL_IMAGE_REGISTRY=mirror.gcr.io` (Google's Docker Hub mirror). The escape hatch
  worked flawlessly — consider documenting it for restricted-network users.

## What worked well

- Greenfield happy path is genuinely smooth: `init` → write one `.sql` file → `db schema
  declarative sync` produced a correct migration with zero setup (no `start` needed first).
- Incremental syncs take ~12–25 s with the catalog cache; container teardown is clean.
- Cross-file dependency ordering works as documented (view declared alphabetically before its
  table is handled), and the round-trip `generate` → `sync` is a clean no-op.
- Destructive changes (column drop) are flagged with the exact statements.
- DML-in-declarative-file and untracked object kinds are detected with clear messages; the
  `supabase issue feature --problem ...` suggestion for unsupported object kinds is a nice touch.
- `--strict-coverage`, `-f` migration naming, `-s` filter narrowing, `_custom/` preservation, and
  the `_cluster/` export layout all behave as the docs PR describes.

## Findings

### 1. `db pull --db-url <foreign Postgres>` produces a poisoned baseline migration (highest impact)

Pulling from a plain Postgres 17 (the migrate-to-Supabase journey in `backup-restore.mdx`)
produced a migration containing:

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "anon";
-- (same for authenticated, service_role, sequences, functions)
REVOKE ALL ON SCHEMA "public" FROM "anon";
REVOKE ALL ON SCHEMA "public" FROM "authenticated";
REVOKE ALL ON SCHEMA "public" FROM "postgres";
REVOKE ALL ON SCHEMA "public" FROM "service_role";
DROP EXTENSION "pgcrypto";
DROP EXTENSION "uuid-ossp";
```

because the diff baseline is always the Supabase-flavored shadow. Consequences:

- `db push` of that migration to a **Supabase project** revokes the API roles' access to
  `public` and drops extensions — it breaks the Data API wholesale.
- `db push` to another **plain Postgres** fails immediately (`role "anon" does not exist`), so
  the pulled migration can't even reproduce the source database it came from.
- The pull also auto-accepted "Update remote migration history table?" (non-TTY) and **wrote
  `supabase_migrations.schema_migrations` into the foreign source database**. A user pointing
  `db pull` at their production RDS/Heroku box will not expect a read-ish command to create a
  schema there.

Suggestions: detect a source without Supabase roles and either diff against a vanilla-Postgres
baseline or fence the Supabase-internal statements behind a loud prompt; never offer the
history-table write when the source has no `supabase_migrations` schema (or require `--yes`
explicitly for it); add a "migrating from external Postgres" cleanup checklist to
`backup-restore.mdx` — today's "Cleaning up generated migrations" section doesn't cover the
REVOKE-ALL-on-schema case.

### 2. `db diff --use-migra` hard-fails on a pg-delta-exported declarative tree

On a project whose `supabase/schemas/` came from `declarative generate`, the documented
single-run fallback dies:

```
Creating local database from declarative schemas: ...
ERROR: extension "pgcrypto" already exists (SQLSTATE 42710)
```

Root cause: the migra path still loads `supabase/schemas/` into its shadow baseline (old
`db diff -f` semantics), while pg-delta's `db diff` explicitly excludes it — and the exported
`_cluster/extensions/*.sql` use bare `CREATE EXTENSION`, which collides with the image defaults.
So the engine flag silently switches *baseline semantics*, and the fallback is unusable for
exactly the users who adopted the new export format. `managing-environments.mdx` recommends
`--use-migra` as a single-run fallback with no caveat.

Suggestion: make `--use-migra` use the same migrations-only baseline (or skip declarative files
when `[experimental.pgdelta]` is enabled), or fail fast with an explicit "migra fallback is not
compatible with a declarative schema tree" message. Document whichever wins.

### 3. Silent non-apply + "No schema changes found" trap leaves the local DB behind

Sequence (all non-interactive, local DB running):

1. `db schema declarative sync` → migration written, **not** applied. No message about apply at
   all — the user has no idea their local DB is now behind.
2. Realizing it, they run `sync --apply` → "No schema changes found" — and the pending migration
   is *still* not applied (apply only happens for a freshly generated diff).
3. Only `supabase migration up` recovers.

Suggestions: when sync skips applying, print "Generated but not applied — run `supabase
migration up` or rerun with `--apply`"; when the diff is empty but local history is behind the
migrations directory, say so (and with `--apply`, apply the pending ones). The docs' quickstart
(sync → start → `migration up`) works, but the guide never mentions that non-interactive sync is
silent about apply state.

### 4. `db pull --declarative` silently reverts unapplied schema-file edits, then produces misleading errors

With one unapplied declarative edit (a `price` column whose migration existed but wasn't applied
locally), `db pull --declarative --local` replaced the tree from the live DB and silently dropped
the `price` declaration. Follow-on effects:

- A later `sync` would emit `DROP COLUMN "price"` — reverting work that's already in a committed
  migration.
- A `_custom/stats.sql` referencing that column made `sync` fail with *"shadow load stuck after 5
  round(s)... Set loadOrder on .pgdelta-export.json to put public/tables/employees.sql before
  _custom/stats.sql"* — a wrong suggestion pointing at an unrelated file; the actual cause was
  the silently-removed column.

Suggestions: before replacing the tree, diff it against the export and warn (or require
`--overwrite`, which today only gates "an existing tree exists", not "you're losing edits");
teach the stuck-loader diagnostic to distinguish "missing column/object" from ordering problems.

### 5. GRANT noise in every generated migration, including a PG17-only keyword

Every table/view in a sync/diff/pull emits three grants the user never wrote, e.g.:

```sql
GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLE "public"."employees" TO "anon", "authenticated";
GRANT DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE ON TABLE "public"."employees" TO "postgres";
GRANT MAINTAIN, REFERENCES, TRIGGER, TRUNCATE ON TABLE "public"."employees" TO "service_role";
```

plus `GRANT USAGE ON TYPE ... TO "postgres"` and, in exports, a `default_privileges.sql` that
encodes the local stack's internals. Why it's bad in user context:

- It reads as nonsense/scary: "why does `anon` get TRUNCATE but not SELECT?" (Answer: the local
  stack's `RevokeDefaultDataApiPrivilegesSql` revokes only CRUD and leaves the rest of the
  initial ALL grant — see next finding.) Users reviewing migrations, as we tell them to, will
  trip on this every single time.
- `MAINTAIN` is PostgreSQL 17-only. These migrations fail on PG15 projects
  (`syntax error at or near "MAINTAIN"` there), so a migration generated against a PG17 local
  stack isn't portable to an older remote.
- The CLI passes `skipDefaultPrivilegeSubtraction: true` to pg-delta, i.e. the machinery to
  suppress default-privilege-derived grants exists and is deliberately off.

`managing-environments.mdx` does say grant lines are "safe to remove", but the declarative guide
(the flow that generates them most) never mentions them. Suggestions: subtract
default-privilege-derived grants (or filter grants involving platform roles) in declarative
output; at minimum gate `MAINTAIN` on the target major version; add a short "why are there GRANT
statements in my migration?" note to the declarative guide.

### 6. The data-API revoke leaves odd privileges behind (platform-parity question)

`LEGACY_START_REVOKE_API_PRIVILEGES_SQL` revokes only `select, insert, update, delete` on tables
(and `usage, select` on sequences), so `anon`/`authenticated`/`service_role` keep
TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on new tables and UPDATE on sequences. TRUNCATE is not
RLS-gated. PostgREST doesn't expose it, but as privilege hygiene it's questionable, and pg-delta
now makes it visible to every user (finding 5). Worth checking whether the platform-side revoke
has the same gap and tightening both to `REVOKE ALL`.

### 7. Error-output UX: raw JSON envelopes, engine jargon, and misdirected "report an issue" ceremony

- In auto-detected agent mode, progress lines are plain text but final status/errors are raw JSON
  (`{"_tag":"Error","error":{...}}`, `{"status":"started",...}` from `db start`). Half-structured
  output is the worst of both worlds for parsers and humans; agent mode should be consistently
  structured (or plain).
- A simple typo in a declarative file (`create tabel ...`) triggers a 5-round shadow reorder
  loop, then an engine-framed error ("shadow load stuck", "reordered (statement-kind)", "Set
  loadOrder on .pgdelta-export.json") — for a syntax error that reordering can never fix. Syntax
  errors should short-circuit round 1 with `file:line` and the Postgres message.
- Expected user errors (DML in a declarative file, `--strict-coverage` rejections, typos) get the
  full "debug bundle + open an issue on pg-toolbelt + open a support ticket" ceremony. That
  ceremony is great for engine bugs; for user errors it teaches people to ignore it. Classify
  before printing it.
- "pg-delta next refused to emit the declarative migration plan" leaks the internal rollout name
  (`SUPABASE_USE_PG_DELTA_NEXT`) into user-facing text.
- The support-ticket line "(only visible to Supabase employees)" is ambiguous — it means the
  bundle contents stay private, but reads like the ticket option itself is employees-only.

### 8. Smaller paper cuts

- `db pull`/`db diff --db-url` against a non-SSL server: "tls error (The server does not support
  SSL connections)" with no hint to append `?sslmode=disable`.
- `migration up` prints "Local database is up to date." as its final line right after applying
  pending migrations — contradictory at a glance.
- `db diff --help`: the `--use-pg-schema` deprecation text says "or the default migra engine"
  while pg-delta is the default for new projects.
- `config.toml`'s commented `format_options` example uses `maxWidth: 80`; the actual default is
  180 (docs PR says 180). Users will read the comment as the default.
- `supabase init` enables pg-delta but scaffolds no `supabase/schemas/` directory or pointer; the
  declarative-first story would land better with an empty `schemas/` + one-line README.

## Docs PR 49280 — verification results

Verified accurate: `sync -f <name>` naming; automatic dependency ordering; DML rejection;
untracked-kind warnings and `--strict-coverage`; `_custom/` never written/pruned by export;
`_cluster/` layout; `-s` filtering narrowing results; `db pull --declarative` replacing the tree
without touching history; 180-char/uppercase default formatting; "non-interactive runs accept
automatically" on the pull history prompt; `[experimental.webhooks]` key exists.

Gaps to address in the PR:

1. `managing-environments.mdx` recommends `--use-migra` as a single-run fallback with no caveat —
   it hard-fails on an exported declarative tree (finding 2).
2. `backup-restore.mdx` / `cli-workflows.mdx` warn about `DROP EXTENSION` in pulled migrations,
   but not about the schema-level `REVOKE ALL ... FROM anon/authenticated/service_role` +
   default-privilege revokes when pulling from a non-Supabase source (finding 1) — that's the
   dangerous one.
3. `cli-workflows.mdx` says the engine "excludes Supabase platform-managed schemas, roles, and
   extensions" — role *grants* are very much in scope of the diff (finding 1/5); the wording
   needs a nuance.
4. The declarative quickstart should mention that non-interactive `sync` doesn't apply and prints
   no apply status (finding 3).
5. The declarative guide should explain the generated GRANT statements (finding 5); today only
   `managing-environments.mdx` does.
6. Multi-file `_1`/`_2` plan output is documented, but I could not produce a multi-unit plan in
   normal flows (even `ALTER TYPE ... ADD VALUE` stayed single-file); consider showing a concrete
   trigger (e.g. `CREATE INDEX CONCURRENTLY`) so users know when to expect it.

## Untested (environment-blocked)

`login`, `link`, `--linked` variants of generate/sync/diff/pull/push, branches interplay, and the
pooler-vs-direct guidance — all blocked by the sandbox egress policy (no `api.supabase.green` /
`api.supabase.com`, no direct 5432/6543 egress). The `--use-migra` engine could not be run to
completion in isolation either (its Deno script fetches `@pgkit/client` from npm inside the
edge-runtime container, which can't verify this sandbox's TLS-intercepting proxy) — finding 2
occurred before that fetch and stands on its own.
