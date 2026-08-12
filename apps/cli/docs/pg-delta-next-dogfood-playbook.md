# Dogfood playbook: pg-delta next on Supabase CLI

Self-contained instructions for a **fresh agent** (or human) to dogfood the bundled in-process pg-delta “next” engine on the CLI. No prior chat context required.

**PR:** https://github.com/supabase/cli/pull/6102

**Branch:** `feat/upgrade-pg-delta-next`

**Goal:** Validate that local Docker, staging remote, and real-project (dbdev) workflows work with the **default** next engine; catch regressions; produce a short scorecard + DX failure writeups.

Do **not** treat this as “run every historical repro forever.” Each pass should (1) confirm previously green paths still green, (2) deeply re-check open failures, (3) report only meaningful deltas.

---

## 1. Success criteria (what “good” means)

Prefer **behavioral** contracts over byte-identical SQL:

| Contract                | Meaning                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Apply + empty follow-up | After generate/sync/pull/push, a second sync/diff/pull reports **no schema changes** (or empty plan).                                                                                                                    |
| Meaningful drift        | Adding one real object produces a migration that contains **that** object (not silent empty, not full-schema noise). No spurious `auth` / `storage` / `realtime` schema creates.                                         |
| Safe upgrade            | Legacy declarative trees must not hard-fail next sync, and must not silently write destructive `DROP EXTENSION` / `cron.unschedule` without clear warning / refuse. Compat gate / repair is OK; cryptic crashes are not. |
| Staging API             | `link` / `branches` work against staging Management API.                                                                                                                                                                 |
| Packaging               | Preview **pkg.pr.new** binary works (wasm embedded; no CI-path `ENOENT`).                                                                                                                                                |
| DX                      | Actionable errors, usable empty-state messaging, debug artifacts that help without corrupting SQL stdout.                                                                                                                |

`db push` does **not** run pg-delta (apply only). Prefer `--db-url` to `db.<ref>.supabase.red:5432` for remote diff/pull (not pooler). Use `POSTGRES_URL_NON_POOLING` + `sslmode=require` for branch URLs.

---

## 2. What you are testing

Default engine = **pg-delta next** (in-process, bundled). **No automatic fallback** to legacy.

| Env var                            | Effect                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------- |
| unset / `true`                     | next (default under test)                                              |
| `SUPABASE_USE_PG_DELTA_NEXT=false` | **legacy** edge-runtime pg-delta (upgrade-compat / opt-out cells only) |

Config gate: `[experimental.pgdelta] enabled = true` and typically `major_version = 17` in `supabase/config.toml`.

| Surface         | Commands                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Declarative     | `db schema declarative generate`, `db schema declarative sync`, `db pull --declarative`                                               |
| Migration-style | `db diff --use-pg-delta` / `--diff-engine pg-delta`, `db pull --diff-engine pg-delta`, `db push`, `db reset`, `migration list/repair` |
| Live URL        | `db diff --from <url\|local\|linked\|migrations> --to <…>`                                                                            |
| Opt-out         | same commands with `SUPABASE_USE_PG_DELTA_NEXT=false`                                                                                 |

**Baseline reminder:** normal `db diff` / migration-style `db pull` compare **`supabase/migrations` ↔ live DB**. Declarative files are **not** that baseline (`DeclarativeSchemaNotUsedAsDiffBaseline`). Use `db schema declarative sync` to compare migrations ↔ declarative desired state.

---

## 3. Prerequisites

### Machine

- macOS with **OrbStack/Docker** healthy (`docker version` shows Server).
- `gh` authenticated to `supabase/cli`.
- `npm` / `pnpm` available.
- Optional CLI worktree / monorepo checkout of the PR — prefer **pkg.pr.new** for dogfood; use local build only if pkg 404 (`dist/supabase` / `SUPABASE_CLI_BINARY_OVERRIDE`).

### Staging

- Profile: `supabase-staging` → API `api.supabase.green`, DB hosts `*.supabase.red`.
- Access token: `SUPABASE_ACCESS_TOKEN` matching `sbp_` + 40 hex chars. On this machine, read from macOS keychain profile `supabase-staging` (see setup snippet). **Never** write tokens/passwords into git or report files.
- Throwaway / dogfood project historically used: ref `tcdjmxannewfbyvudoql` (`pgdelta-dogfood-20260806`). Recreate if missing; password may live in an older dogfood dir — ask the user if absent.

### Corpus (real project)

- **dbdev** migrations (read-only): `/Users/avallete/Documents/Programming/Supa/dbdev/supabase/migrations` (~54 SQL files).
- **Never mutate** that git checkout. Always `cp` into a temp sandbox.

### Prior findings (read before inventing new theory)

| Round / topic                     | Path                                                                       |
| --------------------------------- | -------------------------------------------------------------------------- |
| Round 6 complete scorecard        | `/Users/avallete/tmp/pgdelta-dogfood6/findings/REPORT6.md`                 |
| Round 5 + dbdev                   | `/Users/avallete/tmp/pgdelta-dogfood5/findings/{REPORT5,DBDEV}.md`         |
| Failure B deep dive               | `/Users/avallete/tmp/pgdelta-dogfood4/findings/FAILURE_B_INVESTIGATION.md` |
| Older repro cookbook              | `/Users/avallete/tmp/pgdelta-dogfood/findings/REPRO.md`                    |
| Session handoff (next-pass focus) | `/tmp/pgdelta-next-dogfood-handoff.md`                                     |
| Older cache-root notes            | `~/.cache/supabase-pgdelta-dogfood/`                                       |

If paths differ on another machine: home user, `Documents/Programming` vs `Programming`.

---

## 4. Known landmines (fix these before declaring FAIL)

These have already bitten dogfood runs. Check them **before** filing product bugs.

### 4.1 `~/.supabase/profile` trailing newline

- **Symptom:** `failed to read profile: Unsupported Config Type ""` during shadow provision (`supabase-go db __shadow`).
- **Cause:** Go `getProfileName` does **not** trim file contents; TS does. `supabase-staging\n` is treated as a YAML path with empty extension.
- **Fix before dogfood:**

```sh
# Write WITHOUT a trailing newline
printf '%s' 'supabase-staging' > "$HOME/.supabase/profile"
```

- Prefer `--profile supabase-staging` on remote commands anyway.

### 4.2 Linked project storage image pin (staging)

- **Symptom:** long retries for `storage-api:v1.68.0-queue-bench` (or similar), then `failed to provision the shadow database` on `db diff --linked/--db-url`, migration `db pull`, or even local `declarative sync` in a **linked** workdir.
- **Cause:** `supabase link` writes remote `/storage/v1/version` → `supabase/.temp/storage-version`. Staging may report unpublished tags.
- **Workaround (required after every `link` on affected fleets):**

```sh
# Dockerfile default is a good public pin (confirm in apps/cli-go/pkg/config/templates/Dockerfile)
printf '%s' 'v1.68.10' > supabase/.temp/storage-version
docker image inspect public.ecr.aws/supabase/storage-api:v1.68.10 >/dev/null \
  || docker pull public.ecr.aws/supabase/storage-api:v1.68.10
```

- Deleting the pin file falls back to the embedded Dockerfile image.

### 4.3 `PGDELTA_DEBUG=1` can corrupt stdout / flood diagnostics

- Prior dogfood runs set `PGDELTA_DEBUG=1`, which prints dozens of `invalid_routine_body` / `dangling_edge` lines. That is **debug noise**, not a product failure.
- Redirected `db diff … > patch.sql` can contain clack-framed diagnostics; apply then fails.
- **Rule:** assess “quiet DX” and capture SQL with debug **unset**. Use debug only when investigating. Artifacts (next): `supabase/.temp/pgdelta/v2/debug/<id>/`.

### 4.4 Port conflicts on local `start`

Default DB port `54322` is often taken. Bump ports in `supabase/config.toml` (e.g. +200) or stop leftover stacks. One Docker project at a time if ports collide.

### 4.5 Migration history on fresh local + existing remote

Empty local `migrations/` + remote history → pull blocked with actionable `migration repair --status reverted …` list. That is expected DX, not a next-engine bug.

### 4.6 Flag mutexes

- `db pull --declarative` and `--diff-engine` are mutually exclusive.
- `db schema declarative generate` takes **flags only** (use `--output` / configured declarative path; no positional dir).

### 4.7 Shell hygiene (agents)

- Use **absolute paths**. Do not set `HOME` to a dogfood subdirectory (breaks path expansion).
- Prefer `--agent no` when you need **raw SQL on stdout** for inspection or apply.
- Agents often JSON-wrap CLI stdout; parse `diff` / structured fields when present.
- zsh: `setopt NULL_GLOB` before `*.sql` globs, or use `find`.

---

## 5. One-time setup for a new pass

Create a new root (do not overwrite old rounds until you have a report):

```bash
PASS=7   # increment
ROOT=/Users/avallete/tmp/pgdelta-dogfood${PASS}
mkdir -p "$ROOT/findings" "$ROOT/cli"

# Resolve PR tip + preview package
OID=$(gh pr view 6102 --json headRefOid --jq .headRefOid)
echo "$OID" > "$ROOT/findings/VERSION.txt"
gh api repos/supabase/cli/issues/6102/comments \
  --jq '[.[] | select(.body|contains("pkg.pr.new"))] | .[-1].body' | head -20

npm install --prefix "$ROOT/cli" --engine-strict=false --force \
  "supabase@https://pkg.pr.new/supabase/cli/supabase@${OID}"

cat > "$ROOT/env.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export SUPABASE_PROFILE=supabase-staging
TOKEN_B64=$(security find-generic-password -s "Supabase CLI" -a "supabase-staging" -w | sed 's/^go-keyring-base64://')
export SUPABASE_ACCESS_TOKEN=$(printf '%s' "$TOKEN_B64" | base64 -d)
# Prefer OFF for user-visible DX checks. Turn on only when debugging engine internals.
# export PGDELTA_DEBUG=1
export SUPABASE_YES=true
export SB_PKG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cli/node_modules/.bin/supabase"
SB() { "$SB_PKG" "$@"; }
EOF

source "$ROOT/env.sh"
"$SB_PKG" --version   # expect 0.0.0-pr.6102 or similar
printf '%s' 'supabase-staging' > "$HOME/.supabase/profile"

# Docker
docker version --format '{{.Server.Version}}' || { open -a OrbStack; sleep 5; }
# Stop leftover supabase containers from prior dogfood if ports clash
docker ps --format '{{.Names}}' | rg '^supabase_' || true
```

Init / start helpers (use for every sandbox):

```bash
init_pgdelta_project() {
  local W="$1"
  mkdir -p "$W"
  SB --workdir "$W" init --force
  if ! grep -q '\[experimental.pgdelta\]' "$W/supabase/config.toml"; then
    cat >> "$W/supabase/config.toml" <<'TOML'

[experimental.pgdelta]
enabled = true
TOML
  fi
  perl -pi -e 's/major_version = \d+/major_version = 17/' "$W/supabase/config.toml"
}

start_trimmed() {
  local W="$1"
  SB --workdir "$W" start -x gotrue,realtime,storage-api,imgproxy,kong,inbucket,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
}
```

Direct DB URL pattern (staging):

```text
postgresql://postgres:<PASSWORD>@db.<REF>.supabase.red:5432/postgres?sslmode=require
```

---

## 6. Complete test matrix (primary pass)

Run in this order. Log each scenario under `$ROOT/findings/`. Record PASS / FAIL / SKIP with command, exit code, notable stderr, SQL sample (if any), whether re-diff was empty.

### A. Packaging smoke

```bash
SB --version
# Any project with supabase/database present:
SB --workdir "$W" db schema declarative sync --no-apply --experimental
```

**Fail if:** `ENOENT` … `libpg-query.wasm` or baked CI path `/home/runner/_work/...`.

---

### B. Full dbdev — next happy path (highest value)

```bash
DBDEV=/Users/avallete/Documents/Programming/Supa/dbdev
W="$ROOT/dbdev-local"
init_pgdelta_project "$W"
rm -rf "$W/supabase/migrations" && mkdir -p "$W/supabase/migrations"
cp -a "$DBDEV/supabase/migrations/"*.sql "$W/supabase/migrations/"
start_trimmed "$W"
# If "Started from backup", prefer a clean apply:
SB --workdir "$W" db reset --local --no-seed

SB --workdir "$W" db schema declarative generate --local --overwrite --experimental
# Expect .pgdelta-export.json + cluster/misc.sql (cron) + pgcrypto/uuid-ossp files

SB --workdir "$W" db schema declarative sync --no-apply --experimental
# Expect: No schema changes found
```

**Fail if:** non-empty sync for unchanged DB; hard error on cron/pg_cron; missing cron job in export when live has `cron.job`.

---

### C. dbdev — `db diff` with declarative tree present

```bash
SB --workdir "$W" db query --local "create table public.dogfood_note(id bigint primary key);"
SB --workdir "$W" db diff --local --use-pg-delta -f dogfood_note
```

**Expect:**

- Migration contains `dogfood_note` (and grants).
- Advisory / note: declarative files are **not** the diff baseline (`DeclarativeSchemaNotUsedAsDiffBaseline`).
- Not a silent empty diff.

**Fail if:** empty diff; or huge recreate of the whole dbdev schema solely because `database/` exists.

Clean up: drop table + remove the migration file before later steps if needed.

---

### D. Staging — link / branches

```bash
LW="$ROOT/link-test"
init_pgdelta_project "$LW"
REF=<staging-project-ref>   # e.g. tcdjmxannewfbyvudoql
PASS=<db-password>          # from user / prior secure store — do not commit

SB --workdir "$LW" link --project-ref "$REF" -p "$PASS"
printf '%s' 'v1.68.10' > "$LW/supabase/.temp/storage-version"   # AFTER link
SB --workdir "$LW" branches list --project-ref "$REF"
```

**Fail if:** Effect `SchemaError` on timestamps (`+00:00` vs `Z`) — historically broken, fixed by round 3+.

---

### E. Staging — pull → empty re-pull (dbdev-shaped remote)

```bash
PF="$ROOT/pull-fresh"
init_pgdelta_project "$PF"
DB_URL="postgresql://postgres:${PASS}@db.${REF}.supabase.red:5432/postgres"

# History may conflict with prior dogfood pulls:
SB --workdir "$PF" db pull remote_schema --db-url "$DB_URL" --diff-engine pg-delta
# If conflict: migration repair --status reverted <version> then pull again

SB --workdir "$PF" db pull again --db-url "$DB_URL" --diff-engine pg-delta
# Expect: No schema changes found (exit 1 / LegacyDbPullInSyncError is OK)
```

**Fail if:** shadow apply dies mid-migration (historically function order / `DEFAULT` before callee existed). Inspect pulled SQL if it fails.

---

### F. Mini local — cron + custom schema round-trip

Separate workdir (stop other stacks if ports collide):

```bash
M="$ROOT/mini"
init_pgdelta_project "$M"
start_trimmed "$M"

SB --workdir "$M" db query --local "create table public.items(id bigint primary key, name text not null);"
SB --workdir "$M" db query --local "create type public.item_status as enum ('open','closed');"
SB --workdir "$M" db query --local "alter table public.items add column status public.item_status not null default 'open';"
SB --workdir "$M" db query --local "create extension if not exists pg_cron with schema pg_catalog;"
SB --workdir "$M" db query --local "select cron.schedule('refresh download metrics', '*/30 * * * *', 'select 1;');"
SB --workdir "$M" db query --local "create schema if not exists app;"
SB --workdir "$M" db query --local "create table if not exists app.widgets(id bigint primary key);"

rm -rf "$M/supabase/database" "$M/supabase/migrations/"*.sql
SB --workdir "$M" db schema declarative generate --local --overwrite --experimental
SB --workdir "$M" db schema declarative sync --no-apply --name baseline --experimental
SB --workdir "$M" db reset --local --no-seed
# Empty sync with debug OFF:
unset PGDELTA_DEBUG
SB --workdir "$M" db schema declarative sync --no-apply --experimental
# Expect: No schema changes found, near-zero diagnostic spam
```

**Fail if:** `schema "app" does not exist` on sync; cron job hard-fail (`cron.database_name` / co-located shadow); empty sync non-empty after reset.

---

### G. Failure B — legacy → next upgrade (must deep-check)

This is the main remaining product gap as of round 6.

#### G1. As-generated legacy tree (hard-fail path)

```bash
# On mini or dbdev-local with a live schema already matching migrations/baseline:
rm -rf "$W/supabase/database"
SUPABASE_USE_PG_DELTA_NEXT=false \
  SB --workdir "$W" db schema declarative generate --local --overwrite --experimental

# Inspect:
find "$W/supabase/database" -type f | sort
cat "$W/supabase/database/cluster/extensions/pg_net.sql"  # often: DROP EXTENSION pg_net;
test -f "$W/supabase/database/.pgdelta-export.json" || echo NO_MANIFEST
test -f "$W/supabase/database/cluster/misc.sql" || echo NO_CRON_JOB_FILE

SUPABASE_USE_PG_DELTA_NEXT=true \
  SB --workdir "$W" db schema declarative sync --no-apply --experimental
```

**Historical failure:** shadow load stuck on `pg_net.sql` (`extension "pg_net" does not exist`), sometimes followed by missing `uuid_generate_v4` cascades on dbdev.

**Success:** no hard-fail; either empty plan, CompatibilityError/refuse under `--yes`, or interactive repair — **without** writing destructive drops by default.

#### G2. Legacy without `pg_net.sql` (warn / drops path)

```bash
rm -f "$W/supabase/database/cluster/extensions/pg_net.sql"
SUPABASE_YES=true SUPABASE_USE_PG_DELTA_NEXT=true \
  SB --workdir "$W" db schema declarative sync --no-apply --experimental
```

**Historical behavior:** warning about legacy-implicit `pgcrypto` / `uuid-ossp` and cron job; still may write:

```sql
select cron.unschedule('...');
drop extension "pgcrypto";
drop extension "uuid-ossp";
```

**Why (root cause):** next treats those platform extensions + cron jobs as declaratively managed; legacy export omits them. Sync then plans removals. See `FAILURE_B_INVESTIGATION.md`.

**These drops are destructive if applied/pushed.** Do not apply them as an “upgrade.”

#### G3. Recommended upgrade path (should stay green)

```bash
SUPABASE_USE_PG_DELTA_NEXT=true \
  SB --workdir "$W" db schema declarative generate --local --overwrite \
  --output supabase/database-next --experimental

# Review, then adopt:
rm -rf "$W/supabase/database"
mv "$W/supabase/database-next" "$W/supabase/database"

unset PGDELTA_DEBUG
SB --workdir "$W" db schema declarative sync --no-apply --experimental
# Expect: No schema changes found
```

---

### H. Optional / lower priority

| Test                                                      | When                                  |
| --------------------------------------------------------- | ------------------------------------- |
| `SUPABASE_USE_PG_DELTA_NEXT=false` opt-out smoke          | Only if packaging/legacy path changed |
| Worktree `bun src/legacy/main.ts` + rebuilt `supabase-go` | pkg.pr.new 404                        |
| Preview branch create/delete                              | Branching UX specifically under test  |
| Remote empty `db diff` after push                         | Blocked until pull/shadow apply green |
| Staging linked migration/declarative loops (§8)           | When validating full remote↔local UX  |
| Remote ↔ remote branch diffs (§9 matrix C)                | When shadow/storage pins are painful  |

---

## 7. Extended local / DX cells (when not covered above)

Use these when the primary matrix does not already prove the behavior, or when chasing a specific DX regression.

| ID  | Scenario                                                                                           | Expect                                                                                          |
| --- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A0  | Declarative SQL **without** `.pgdelta-export.json` and without extension decls → sync `--no-apply` | Non-interactive refusal listing implicit extensions + `CREATE EXTENSION` / generate alternative |
| A3  | Edit declarative (enum value, drop table, new table) → sync → `db push --local` → empty sync       | Drop warning; multi-file OK; converges                                                          |
| A7  | Bad URL, empty declarative dir, `--strict-coverage`                                                | Actionable errors; artifacts if debug on                                                        |
| D1  | `PGDELTA_DEBUG=1`                                                                                  | Debug dir under `.temp/pgdelta/v2/debug/`; **SQL stdout stays clean** (file if still mixed)     |
| D2  | Empty `db pull` messaging                                                                          | Should not look like a hard product bug / issue-tracker funnel when simply up to date           |
| D3  | Bad DB password                                                                                    | Clear `28P01` + `SUPABASE_DB_PASSWORD` hint                                                     |
| D4  | `--strict-coverage` vs default `unmodeled_kind` summary                                            | Documented, not over-failed                                                                     |
| D5  | Publications, storage buckets, `security_invoker` views                                            | Known hard cases — document, don’t over-fail                                                    |

Seed schema idea (after extensions exist):

```sql
create type public.account_state as enum ('pending', 'active');
create table public.disposable_note (
  id bigint generated by default as identity primary key,
  body text not null
);
create view public.auth_user_emails as
select id, email from auth.users;
```

---

## 8. Staging linked loops (optional depth)

**Always re-pin storage after `link`.** Prefer `--agent no` for raw SQL.

### 8.1 Migration remote ↔ local

```sh
cd "$LOOP"   # linked project workdir
printf '%s' 'v1.68.10' > supabase/.temp/storage-version

"$SB" migration list --linked --profile supabase-staging --agent no
# repair remote-only versions as suggested, then:
"$SB" db pull from_remote_baseline --linked --diff-engine pg-delta \
  --profile supabase-staging --agent no

"$SB" db diff --linked --use-pg-delta --profile supabase-staging --agent no
# expect: No schema changes found

# Local → remote
cat > supabase/migrations/$(date -u +%Y%m%d%H%M%S)_add_flag.sql <<'SQL'
alter table public.dogfood_note add column if not exists flag boolean not null default false;
SQL
"$SB" db push --linked --profile supabase-staging --agent no
"$SB" db diff --linked --use-pg-delta --profile supabase-staging --agent no

# Remote → local
"$SB" db query --linked --profile supabase-staging \
  "alter table public.dogfood_note add column if not exists remote_only_at timestamptz;"
"$SB" db pull remote_only_at --linked --diff-engine pg-delta \
  --profile supabase-staging --agent no
"$SB" db diff --linked --use-pg-delta --profile supabase-staging --agent no
```

### 8.2 Declarative remote loop

```sh
"$SB" db pull --declarative --linked --experimental --profile supabase-staging --agent no
# edit supabase/schemas/... add a table file
"$SB" db schema declarative sync --no-apply --name add_x --experimental --agent no
"$SB" db push --linked --profile supabase-staging --agent no
"$SB" db schema declarative sync --no-apply --experimental --agent no
"$SB" db diff --linked --use-pg-delta --profile supabase-staging --agent no
```

### 8.3 Linked matrix checklist

| ID  | Scenario                                                 | Expect                                                    |
| --- | -------------------------------------------------------- | --------------------------------------------------------- |
| B1  | Empty linked diff after migrations match                 | Empty                                                     |
| B2  | Add migration → push → empty linked diff                 | Applies; converges                                        |
| B3  | Remote ALTER → pull → empty diff                         | Single focused migration                                  |
| B4  | `db pull --declarative` or `generate --linked`           | Manifest + nested tree; user objects only                 |
| B5  | Edit declarative → sync → push → empty sync + empty diff | Full loop                                                 |
| B6  | Delete declarative table → sync → drop warning → push    | Safe, warned                                              |
| B7  | After pulls: `db reset --local --no-seed`                | Migration chain applies                                   |
| B8  | Fresh local, remote has history → repair → pull baseline | Actionable repair DX                                      |
| B9  | Repeat B1/B3 with opt-out                                | Same semantic empty/non-empty; note SSL/image differences |

---

## 9. Staging branches — remote ↔ remote (optional)

```sh
"$SB" branches create loop-a --project-ref <REF> --profile supabase-staging --experimental
"$SB" branches create loop-b --project-ref <REF> --profile supabase-staging --experimental
# wait until status != CREATING_PROJECT
"$SB" branches get loop-a --project-ref <REF> --profile supabase-staging -o json
# use POSTGRES_URL_NON_POOLING + sslmode=require
```

| ID  | Scenario                                                            | Expect                              |
| --- | ------------------------------------------------------------------- | ----------------------------------- |
| C1  | Parent → branch `db diff --from/--to`                               | Meaningful; no managed-schema noise |
| C2  | Branch ↔ branch after diverge                                       | Only intentional objects            |
| C3  | Self-diff `--from U --to U`                                         | Empty                               |
| C4  | Capture clean SQL (`PGDELTA_DEBUG` **off**) → apply → re-diff empty | Convergence                         |
| C5  | `generate --db-url <branch> --overwrite`                            | Branch-only objects in tree         |

Live `--from/--to` does **not** need local shadow image matching — prefer it when shadow/storage pins are painful.

```sh
unset PGDELTA_DEBUG
"$SB" db diff --from "$URL_B" --to "$URL_A" --use-pg-delta \
  --profile supabase-staging --agent no > /tmp/b-to-a.sql
# Apply statements on B (db query is single-statement-friendly)
"$SB" db diff --from "$URL_A" --to "$URL_B" --use-pg-delta \
  --profile supabase-staging --agent no
# expect empty
```

---

## 10. What “good” SQL looks like

- User objects: tables/types/views/indexes/FKs you changed.
- Supabase role grants (`anon` / `authenticated` / `service_role` / `postgres`) are **normal** under the supabase integration profile — not necessarily noise.
- **Bad:** `CREATE SCHEMA auth|storage|realtime`, recreating managed internals, huge unrelated privilege churn every empty sync.
- Watch for **default-privilege revoke-then-grant** churn when syncing a fresh generate into empty migrations — note it if present.

---

## 11. Known failure catalog (what to watch for)

| Symptom                                                                  | Likely cause                    | Severity                                             |
| ------------------------------------------------------------------------ | ------------------------------- | ---------------------------------------------------- |
| Silent empty `db diff` while local has new tables and `database/` exists | Diff incorrectly ignoring drift | **Critical** (was regressed; fixed)                  |
| `schema "app" does not exist` on sync/diff                               | Assumed-schema / shadow seeding | High (fixed with isolate shadow)                     |
| Cron sync: shadow DB ≠ `cron.database_name`                              | Co-located shadow               | High (fixed with isolate shadow)                     |
| Legacy → next: `DROP EXTENSION pg_net` load fail                         | Legacy emits bare DROP file     | **Open** as of round 6                               |
| Legacy → next: `drop pgcrypto` / `uuid-ossp` / `cron.unschedule`         | Exporter coverage mismatch      | **Open** (warn improved; still writes under `--yes`) |
| Empty re-pull: function / DEFAULT order on shadow                        | Pulled SQL not replayable       | Was open; fixed by round 5+                          |
| Staging `SchemaError` `+00:00`                                           | Management API timestamp decode | Fixed                                                |
| `ENOENT` libpg-query.wasm under `/home/runner/...`                       | pkg embed missing               | Fixed in source; always recheck pkg                  |
| `SET LOCAL` warning on apply                                             | Migration exec outside txn      | Fixed observation                                    |
| Flood of `pg-delta next diagnostic:` lines                               | Often `PGDELTA_DEBUG=1`         | Check debug off before filing                        |
| `Unsupported Config Type ""`                                             | Profile file trailing newline   | Landmine (§4.1)                                      |
| Shadow fails pulling `storage-api:…`                                     | Staging storage-version pin     | Landmine (§4.2)                                      |

---

## 12. Opt-out checklist

For critical cells, re-run once with:

```sh
export SUPABASE_USE_PG_DELTA_NEXT=false
```

Notes:

- No auto-fallback: next failures must not silently call legacy.
- Proxy/edge-runtime image may be missing → SKIP with reason, not FAIL.
- Flag can also live in `supabase/.env`; shell env wins. Re-check if opt-out appears ignored (layer construction before project env load).

---

## 13. How to report

Write `$ROOT/findings/REPORT${PASS}.md`:

1. **Header:** date, PR URL, full commit SHA, binary (`pkg.pr.new` vs worktree), staging project ref, storage pin used.
2. **Verdict:** go / conditional go / no-go — one paragraph.
3. **Scorecard table** vs previous round (PASS / FAIL / improved / SKIP).
4. **Open failures only** as DX user stories:

```markdown
### Failure X — short title

**As a user** …
**I want to** …
**so I run:** (exact commands)

**I expect:** …
**I get:** (verbatim error / SQL)

**Impact:** …
**Artifacts:** findings/….log
```

5. **Green smokes:** one line each.
6. **DX nits** / SQL sample paths.
7. **Cleanup** commands used.
8. **No secrets** in the report.

### Severity guide

| Severity   | Examples                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------- |
| Blocker    | Linked shadow unusable without obscure pin; data-lossy SQL; non-convergence after apply           |
| High       | Debug corrupts stdout; cryptic profile errors; opt-out broken; Failure B hard-fail / silent drops |
| Medium     | Noisy diagnostics; empty-pull issue footer; privilege churn                                       |
| Low / docs | History repair ceremony; known unmanaged object types                                             |

Also update `/tmp/pgdelta-next-dogfood-handoff.md` if the next-pass priorities changed.

---

## 14. Agent operating rules

1. Prefer **pkg.pr.new** at the PR HEAD SHA; record SHA in `VERSION.txt`.
2. Use a **new** `$ROOT` per pass; keep prior rounds for comparison.
3. Copy dbdev migrations; never edit the dbdev repo.
4. Trimmed `supabase start -x …` is enough; full stack not required.
5. One Docker project at a time if ports collide (`supabase stop` the other workdir).
6. `SUPABASE_YES=true` is fine for automation but note it may **skip interactive repair** and still write drop migrations — call that out.
7. Do not apply Failure B drop migrations to staging.
8. Do not commit dogfood sandboxes or passwords.
9. Re-pin storage after every `link` on staging (§4.2).
10. Leave `PGDELTA_DEBUG` unset for quiet DX / SQL capture.
11. Repo coding rules (`AGENTS.md`) apply only if you **change CLI code**; pure dogfood is read/execute/report.

---

## 15. Fast vs complete pass

**Fast (after a narrow fix):** G1/G2/G3 + B (dbdev empty sync) + E (empty re-pull if pull/SQL touched).

**Complete (new preview build / large PR update):** A–G all, plus quiet mini empty sync with debug off, plus adopt-path G3. Add §8 / §9 only when the change touches linked shadow, declarative remote loops, or `--from/--to`.

As of round 6 (`f9bd2890b`), complete pass should still expect **G1 fail**, **G2 warn+drops**, everything else green if no regressions.

---

## 16. Cleanup

```sh
"$SB" branches delete loop-a --project-ref <REF> --profile supabase-staging --experimental --yes
"$SB" branches delete loop-b --project-ref <REF> --profile supabase-staging --experimental --yes
# Only if you created a throwaway project this pass:
"$SB" projects delete <REF> --profile supabase-staging --yes
"$SB" stop --workdir "$W" --no-backup
"$SB" stop --workdir "$M" --no-backup
```

Restore the user’s `~/.supabase/profile` if you changed it (still **no trailing newline**).

---

## 17. Quick triage runbook

| Symptom                                          | Check                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| `Unsupported Config Type ""`                     | Profile file newline / contents (§4.1)                                  |
| Pulling `storage-api:…` fails                    | `cat supabase/.temp/storage-version`; re-pin; re-link rewrites it       |
| Shadow fails after “Initialising schema…”        | Storage pin, Docker pull, incomplete local migrations into empty shadow |
| Diff SQL full of diagnostics                     | `PGDELTA_DEBUG` on → unset and redo                                     |
| Pull blocked on history                          | `migration list` + suggested `migration repair`                         |
| Declarative sync wants extensions                | Add `extension.sql` or `generate` first (compat gate)                   |
| `db diff` ignores declarative edits              | Use `db schema declarative sync`, not `db diff`                         |
| Legacy sync hard-fails on `pg_net`               | Failure B G1 — see §6.G                                                 |
| Sync writes `DROP EXTENSION` / `cron.unschedule` | Failure B G2 — do not apply; use G3 adopt path                          |
| Opt-out SSL probe fails on staging               | Note separately; confirm next path still works                          |
| `ENOENT` … `libpg-query.wasm`                    | Packaging regression — fail the pass                                    |

---

## 18. References in this repo

- PR-facing behavior notes: `src/legacy/commands/db/{diff,pull}/SIDE_EFFECTS.md`, `…/schema/declarative/{sync,generate}/SIDE_EFFECTS.md`
- Live convergence harness: `src/legacy/commands/db/shared/legacy-pgdelta-next.live.test.ts`
- Engine selector: `src/legacy/commands/db/shared/legacy-pgdelta-engine.layer.ts`
- Storage pin load: `apps/cli-go/pkg/config/config.go` (`StorageVersionPath`), shadow storage job: `apps/cli-go/internal/db/start/start.go` (`initStorageJob`)
- Profile load trap: `apps/cli-go/internal/utils/profile.go` (`getProfileName`)

---

## 19. Suggested skills (for the next agent)

- None required for dogfood itself.
- If implementing fixes in the CLI after findings: follow workspace `AGENTS.md` (pnpm, Effect under `.repos/effect/`, `pnpm check:all` in changed workspace).
- Handoff after a pass: Cursor/agent `handoff` skill → OS temp.
- Split fix PRs: Cursor `split-to-prs` skill if the user asks.
