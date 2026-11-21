#!/usr/bin/env bash
# End-to-end check of the experimental Spark backend: a project opts in through config.toml, and
# start runs Spark, sparkmeta and Studio on the native stack; then supabase-js with auth and
# RLS, Studio, the Supabase MCP server, and the Spark command tree (gen types, db pull/diff/push/query,
# migration list) on the local target, which calls Spark through the stack's API URL with no profile,
# token or link, with diff and pull on a shadow Postgres loaded from the project's dump; unsupported
# SQL, the commands the tree leaves out, restart and reset; then link and each command once on the
# linked project, through the Management API stand-in; and stop.
# Needs: a Spark binary (SUPABASE_SPARK_BIN), the PoC example apps (SPARK_EXAMPLE_DIR, with
# `bun install` run), a built Supabase MCP server (SUPABASE_MCP_CLI), bun, node, jq, curl, python3,
# and a Studio launcher with the Spark pg-meta fallbacks (SUPABASE_SPARK_STUDIO_BIN): the pinned
# Studio build has none, so the Studio step needs it.
# SUPABASE_CLI_BIN runs a compiled CLI instead of the source. Uses ports 54321 and 54323.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CLI_MAIN="$HERE/../../src/main.ts"
# Defaults expect the spark and mcp checkouts next to this repository.
SIBLINGS="$(cd "$HERE/../../../../.." && pwd)"
SPARK_BIN="${SUPABASE_SPARK_BIN:-$SIBLINGS/spark/target/release/spark}"
EXAMPLE="${SPARK_EXAMPLE_DIR:-$SIBLINGS/spark/poc/supabase-spark-dev/example}"
MCP_CLI="${SUPABASE_MCP_CLI:-$SIBLINGS/mcp/packages/mcp-server-supabase/dist/cli.js}"
STUDIO_BIN="${SUPABASE_SPARK_STUDIO_BIN:-}"
export SUPABASE_NO_UPDATE_NOTIFIER=1 SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
# The local target needs none of these; the remote block at the end sets them.
unset SUPABASE_PROFILE SUPABASE_ACCESS_TOKEN SUPABASE_PROJECT_ID SUPABASE_YES
WORK="$(mktemp -d)"
PROJECT="$WORK/spark-todos"
API=http://127.0.0.1:54321
# The stand-in Management API accepts any token in the client's format and any 20-letter ref.
PROJECT_REF=sparkpocprojectlocal
ACCESS_TOKEN="sbp_$(printf '0%.0s' $(seq 40))"
LOG="$WORK/e2e.log"

cleanup() {
  local code=$?
  (cd "$PROJECT" 2>/dev/null && sb stack destroy --yes >/dev/null 2>&1) || true
  if [ "$code" -eq 0 ]; then rm -rf "$WORK"; else echo "✘ failed (exit $code); project and log kept in $WORK" >&2; fi
}
trap cleanup EXIT

ok() { printf '✔ %s\n' "$*"; }
fail() { printf '✘ %s\n' "$*" >&2; [ -s "$LOG" ] && tail -40 "$LOG" >&2; exit 1; }
run() { "$@" >"$LOG" 2>&1 || fail "$* (exit $?)"; }
# Agent detection would switch the CLI to JSON output; the checks below read text output.
for agent_var in AI_AGENT CLAUDECODE CLAUDE_CODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_IS_COWORK CURSOR_AGENT CURSOR_TRACE_ID CODEX_SANDBOX CODEX_CI CODEX_THREAD_ID GEMINI_CLI OPENCODE_CLIENT REPL_ID; do unset "$agent_var"; done
if [ -n "${SUPABASE_CLI_BIN:-}" ]; then
  sb() { "$SUPABASE_CLI_BIN" "$@"; }
else
  sb() { bun "$CLI_MAIN" "$@"; }
fi
key() { sb status --env | sed -n "s/^$1='\\(.*\\)'\$/\\1/p"; }
check() { run env ANON_KEY="$ANON_KEY" SERVICE_KEY="$SERVICE_KEY" node "$EXAMPLE/$1"; }
rest() { curl -s "$API/rest/v1/$1" -H "apikey: $SERVICE_KEY" -H "authorization: Bearer $SERVICE_KEY" "${@:2}"; }
no_postgres() {
  local found
  # Scoped to this project: other Postgres on the machine (test suites, other stacks) is not this stack's.
  local real
  real="$(cd "$PROJECT" && pwd -P)"
  found="$( (docker ps --format '{{.Image}} {{.Names}} {{.Label "com.supabase.stack-root"}} {{.Label "com.supabase.cli.workdir"}}' 2>/dev/null || true; pgrep -af postgres || true) |
    grep -Ei 'postgres' | grep -F -e "$PROJECT" -e "$real" || true)"
  [ -z "$found" ] || fail "Postgres is running: $found"
}

for tool in bun node jq curl python3; do command -v "$tool" >/dev/null || fail "missing $tool"; done
[ -x "$SPARK_BIN" ] || fail "no spark binary at $SPARK_BIN"
[ -d "$EXAMPLE/node_modules" ] || fail "run bun install in $EXAMPLE"
[ -f "$MCP_CLI" ] || fail "no Supabase MCP server at $MCP_CLI"
[ -n "$STUDIO_BIN" ] || fail "set SUPABASE_SPARK_STUDIO_BIN to a Studio launcher with the Spark pg-meta fallbacks: the pinned Studio build has none, so the Studio step cannot pass"
[ -x "$STUDIO_BIN" ] || fail "no Studio launcher at SUPABASE_SPARK_STUDIO_BIN=$STUDIO_BIN"
# The path checked here, absolute, is the one the CLI gets: the variable wins over config.toml.
STUDIO_BIN="$(cd "$(dirname "$STUDIO_BIN")" && pwd -P)/$(basename "$STUDIO_BIN")"
export SUPABASE_EXPERIMENTAL_SPARK_STUDIO_EXECUTABLE="$STUDIO_BIN"
ok "setup: spark, bun, node, the MCP server, the Studio launcher and the example apps are ready"

mkdir -p "$PROJECT" && cd "$PROJECT"
run sb init
mkdir -p supabase/migrations
cp "$EXAMPLE/todos.sql" supabase/migrations/20260101000000_todos.sql
cat >>supabase/config.toml <<TOML

[experimental.spark]
enabled = true
executable = "$SPARK_BIN"
TOML
ok "supabase init in a new project, a todos migration, and [experimental.spark] enabled in config.toml"

run sb start
grep -q "Stack is ready" "$LOG" && grep -q "spark" "$LOG" || fail "supabase start reported no Spark stack"
no_postgres
ok "supabase start: Spark, sparkmeta and Studio on the native stack (no Postgres)"

run sb status
grep -q "$API" "$LOG" && grep -q "spark" "$LOG" || fail "supabase status printed no Spark stack"
ANON_KEY="$(key ANON_KEY)"
SERVICE_KEY="$(key SERVICE_ROLE_KEY)"
[ -n "$ANON_KEY" ] && [ -n "$SERVICE_KEY" ] || fail "supabase status --env printed no keys"
ok "supabase status reports the Spark stack and its keys"

check app.test.mjs
ok "app (supabase-js): sign up, CRUD and RLS isolation on todos"

engine="$(curl -sf http://127.0.0.1:54323/api/platform/projects/default | jq -r .postgres_engine)"
[ "$engine" = spark ] || fail "Studio's project detail reports engine '$engine', not spark"
check studio.check.mjs
no_postgres
ok "Studio: table editor rows, create table and insert row from the UI, policies page, SQL editor"

grep -q "process.env.MCP_CLI" "$EXAMPLE/mcp.check.mjs" || fail "the MCP check does not start the MCP server from MCP_CLI"
run env ANON_KEY="$ANON_KEY" MCP_CLI="$MCP_CLI" node "$EXAMPLE/mcp.check.mjs"
ls supabase/migrations/*_add_labels.sql >/dev/null 2>&1 || fail "apply_migration wrote no migration file"
ok "MCP: list_tables, apply_migration, execute_sql, list_migrations, generate_typescript_types, get_project_url"

run sb gen types typescript
grep -q '"todos": {' "$LOG" || fail "gen types has no todos table"
[ ! -e supabase/.link.json ] || fail "the local steps found a supabase/.link.json"
ok "gen types typescript on the local target (no profile, token or link)"

run sb db pull
[ -f supabase/schemas/public/tables/todos.sql ] || fail "db pull wrote no supabase/schemas/public/tables/todos.sql"
grep -rqi 'create policy "Users manage their own todos"' supabase/schemas || fail "db pull exported no todos policy"
# The shadow image's own grants, default privileges and extensions are not in Spark, which refuses them.
for image_only in default_privileges.sql adp_wipes.sql schema.sql pgcrypto.sql uuid-ossp.sql; do
  [ -z "$(find supabase/schemas -name "$image_only")" ] || fail "db pull wrote $image_only, which comes from the shadow image"
done
ok "db pull: the project's dump in a shadow Postgres, exported by pg-delta to supabase/schemas, with the RLS policies and none of the image-only files"

out="$(sb db diff -f noop 2>"$LOG")" || fail "db diff -f noop"
[ "$out" = "No schema changes found" ] || fail "db diff -f noop: $out"
no_postgres
ok "db diff on the freshly pulled files (Spark, dump, shadow round trip): No schema changes found"

python3 - <<'PY'
import pathlib
todos = pathlib.Path("supabase/schemas/public/tables/todos.sql")
todos.write_text(todos.read_text().replace('"done"', '"priority" integer not null default 0,\n  "done"', 1))
pathlib.Path("supabase/schemas/public/tables/projects.sql").write_text("""create table "public"."projects" (
  "id"       bigint generated by default as identity primary key,
  "owner_id" uuid not null default auth.uid() references auth.users (id) on delete cascade,
  "name"     text not null
);
create index "projects_owner_id_idx" on "public"."projects" ("owner_id");
alter table "public"."projects" enable row level security;
create policy "Owners manage projects" on "public"."projects" for all to authenticated
  using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
grant all on table "public"."projects" to "authenticated";
""")
PY
todos_before="$(rest 'todos?select=id' | jq length)"
sb db diff -f add_projects >"$LOG" 2>&1 || fail "db diff -f add_projects"
grep -q "Dry run on Spark: OK" "$LOG" || fail "db diff -f add_projects: no \"Dry run on Spark: OK\""
ls supabase/migrations/*_add_projects.sql >/dev/null 2>&1 || fail "no add_projects migration file"
ok "edit schema files (new column, projects table with FK, RLS policy, index); db diff -f add_projects: Dry run on Spark: OK"

run sb db push
grep -q "Finished supabase db push" "$LOG" || fail "db push did not finish"
policies="$(sb db query -o json "select policyname from pg_policies where schemaname = 'public'" 2>"$LOG" | jq -r '.[].policyname')" || fail "db query pg_policies"
for policy in "Owners manage projects" "Users manage their own todos"; do
  grep -qx "$policy" <<<"$policies" || fail "pg_policies has no \"$policy\" policy after push: $policies"
done
[ "$(rest 'todos?select=id' | jq length)" = "$todos_before" ] || fail "db push lost todos rows"
ok "db push applies the migration (dry run first), existing rows kept ($todos_before todos); pg_policies lists both policies"

code=$(rest 'todos?select=priority' -o /dev/null -w '%{http_code}')
[ "$code" = 200 ] || fail "GET todos?select=priority: HTTP $code"
check feature.check.mjs
fk=$(rest projects -XPOST -H 'content-type: application/json' -d '{"name":"orphan","owner_id":"00000000-0000-0000-0000-000000000000"}' | jq -r .code)
[ "$fk" = 23503 ] || fail "the projects foreign key is not enforced (got $fk)"
ok "app: the new column and the projects table work over REST (RLS, foreign key enforced)"

out="$(sb db diff -f again 2>"$LOG")" || fail "db diff -f again"
[ "$out" = "No schema changes found" ] || fail "db diff after push: $out"
ok "db diff after push: No schema changes found"

# Piped, so the command's stdin wiring runs too.
out="$(echo "select count(*) as n from public.todos" | sb db query -o json 2>"$LOG")" || fail "db query select count"
jq -e '.[0] | has("n")' <<<"$out" >/dev/null || fail "db query -o json returned no row with n: $out"
ok "db query -o json: a JSON array of rows from the local Spark server"

# A write through the query route must outlive a later rolled-back script. The query route has
# no JWT, so auth.uid() is null: the probe row borrows a user the app checks created.
uid="$(sb db query -o json "select id from auth.users limit 1" 2>"$LOG" | jq -r '.[0].id')" || fail "db query select auth.users"
[ -n "$uid" ] && [ "$uid" != null ] || fail "db query found no auth user to own the probe row"
todos_before="$(rest 'todos?select=id' | jq length)"
out="$(sb db query -o json "insert into public.todos (user_id, title) values ('$uid', 'db query probe') returning id, title" 2>"$LOG")" || fail "db query insert"
probe_id="$(jq -r '.[0].id' <<<"$out")"
[ -n "$probe_id" ] && [ "$probe_id" != null ] || fail "db query insert returned no id: $out"
if sb db query "insert into public.todos (user_id, title) values ('$uid', 'rolled back'); insert into public.todos (user_id, title) values ('$uid', '')" >"$LOG" 2>&1; then
  fail "db query ran a script whose second statement violates a check constraint"
fi
grep -q 'violates check constraint' "$LOG" || fail "db query failed for another reason than the second statement's check constraint"
out="$(sb db query -o json "select id, title from public.todos where title in ('db query probe', 'rolled back') order by id" 2>"$LOG")" || fail "db query select probe"
[ "$(jq -r 'map(.title) | join(",")' <<<"$out")" = "db query probe" ] || fail "after a rolled-back script the probe row is not the only one left: $out"
run sb db query "delete from public.todos where id = $probe_id"
[ "$(rest 'todos?select=id' | jq length)" = "$todos_before" ] || fail "db query left the probe row behind"
ok "db query: a write survives a later rolled-back script; the failing script's first statement is rolled back"

if sb db query --read-only "insert into public.todos (user_id, title) values ('$uid', 'read only')" >"$LOG" 2>&1; then
  fail "db query --read-only ran an insert"
fi
grep -Eq 'read-only|query_only' "$LOG" || fail "db query --read-only failed for another reason than the write"
[ "$(rest 'todos?select=id' | jq length)" = "$todos_before" ] || fail "db query --read-only wrote a row"
ok "db query --read-only refuses an insert"

cat > supabase/schemas/public/functions.sql <<'SQL'
create function public.add(a int, b int) returns int
  language plpgsql as $$ begin return a + b; end $$;
SQL
if sb db diff -f with_function >"$LOG" 2>&1; then fail "a schema file with a function was accepted"; fi
grep -Eiq '(unsupported|error) [^:]*: create (or replace )?function [^ ]*add' "$LOG" || fail "the refusal names no function statement"
grep -q 'supabase/schemas/public/functions.sql:[0-9]' "$LOG" || fail "the refusal names no schema file and line"
ls supabase/migrations/*_with_function.sql >/dev/null 2>&1 && fail "a refused migration was written"
ok "an unsupported function in a schema file is refused by the Spark dry run, at $(grep -m1 -Eo 'functions\.sql:[0-9]+' "$LOG"): $(grep -m1 -Eio '(unsupported|error) [^:]*: create (or replace )?function.{0,60}' "$LOG")"
rm supabase/schemas/public/functions.sql

# Two pending files: a good one, then one Spark refuses. The combined dry run must stop both.
history_before="$(sb migration list 2>&1)"
printf 'create table public.notes (id bigint primary key);\n' >supabase/migrations/20990101000000_notes.sql
printf -- '-- a date column\ncreate table public.events (\n  id bigint primary key,\n  day date\n);\n' >supabase/migrations/20990101000001_events.sql
if sb db push >"$LOG" 2>&1; then fail "db push applied a migration Spark refuses"; fi
grep -q 'supabase/migrations/20990101000001_events.sql:2' "$LOG" || fail "the push refusal does not name the refused statement's file and line"
[ "$(rest 'notes?select=id' -o /dev/null -w '%{http_code}')" != 200 ] || fail "db push applied the good file before the refused one"
rm supabase/migrations/20990101000000_notes.sql supabase/migrations/20990101000001_events.sql
[ "$(sb migration list 2>&1)" = "$history_before" ] || fail "migration history changed after a refused push"
ok "db push with a refused pending migration applies nothing (one dry run over all pending files), at $(grep -m1 -Eo '20990101000001_events\.sql:[0-9]+' "$LOG"): $(grep -m1 -Eo 'type \"date\" is not supported' "$LOG")"

# Two files with one version fail before anything is applied.
printf 'create table public.notes (id bigint primary key);\n' >supabase/migrations/20990101000000_notes.sql
printf 'create table public.other (id bigint primary key);\n' >supabase/migrations/20990101000000_other.sql
if sb db push >"$LOG" 2>&1; then fail "db push accepted two migrations with one version"; fi
grep -q '20990101000000_notes' "$LOG" && grep -q '20990101000000_other' "$LOG" || fail "the duplicate-version error names no file"
[ "$(rest 'notes?select=id' -o /dev/null -w '%{http_code}')" != 200 ] || fail "db push applied a duplicate-version migration"
rm supabase/migrations/20990101000000_notes.sql supabase/migrations/20990101000000_other.sql
ok "db push refuses two migration files with the same version before applying anything"

for cmd in "db dump" "db lint" "inspect db table-stats" "test db"; do
  # shellcheck disable=SC2086
  if sb $cmd >"$LOG" 2>&1; then fail "supabase $cmd succeeded on Spark"; fi
  grep -Eqi "unknown|not found|invalid subcommand" "$LOG" || fail "supabase $cmd: not reported as an unknown command"
done
ok "db dump, db lint, inspect db and test db are not in the Spark command tree"

rows_before="$(rest 'todos?select=id' | jq length)"
run sb stop
run sb start
[ "$(rest 'todos?select=id' | jq length)" = "$rows_before" ] || fail "todos rows changed across restart"
out="$(sb db diff -f after_restart 2>"$LOG")" || fail "db diff after restart"
[ "$out" = "No schema changes found" ] || fail "db diff after restart: $out"
no_postgres
ok "stop and start (the project stays on Spark): $rows_before todos survive, db diff still clean"

run sb db reset
grep -q "Finished supabase db reset" "$LOG" || fail "db reset did not finish"
[ "$(rest 'todos?select=id' | jq length)" = 0 ] || fail "db reset kept todos rows"
code=$(rest 'projects?select=id' -o /dev/null -w '%{http_code}')
[ "$code" = 200 ] || fail "projects missing after reset (HTTP $code)"
check app.test.mjs
ok "db reset: data removed, all migrations replayed, the app works"

# The linked project's path: the Management API, served locally by the stand-in routes.
cat >"$WORK/spark-profile.yaml" <<YAML
name: spark-local
api_url: $API
dashboard_url: http://127.0.0.1:54323
project_host: localhost
YAML
export SUPABASE_PROFILE="$WORK/spark-profile.yaml" SUPABASE_ACCESS_TOKEN="$ACCESS_TOKEN"
run sb link --project-ref "$PROJECT_REF"
grep -q "Finished supabase link" "$LOG" || fail "supabase link did not finish"
[ "$(jq -r .project.ref supabase/.link.json)" = "$PROJECT_REF" ] || fail "supabase link wrote no supabase/.link.json"
out="$(sb db query --remote --read-only -o json "select count(*) as n from public.projects" 2>"$LOG")" || fail "db query --remote --read-only"
[ "$(jq -r '.[0].n' <<<"$out")" = 0 ] || fail "db query --remote --read-only: $out"
if sb db query --remote "delete from public.projects" >"$LOG" 2>&1; then fail "db query --remote wrote without confirmation"; fi
grep -q -- "--yes" "$LOG" || fail "db query --remote asked for no confirmation: $(cat "$LOG")"
run sb migration list --remote
add_projects="$(basename supabase/migrations/*_add_projects.sql | cut -d_ -f1)"
grep -Eq "$add_projects.*$add_projects" "$LOG" || fail "migration list --remote shows add_projects on one side only: $(cat "$LOG")"
run sb gen types typescript --remote
grep -q '"projects": {' "$LOG" || fail "gen types --remote has no projects table"
out="$(sb db diff --remote 2>"$LOG")" || fail "db diff --remote"
[ "$out" = "No schema changes found" ] || fail "db diff --remote: $out"
run sb db push --remote
grep -q "Remote database is up to date" "$LOG" || fail "db push --remote: $(cat "$LOG")"
# A pending migration through the linked path: its dry run and its apply are the Management API's.
printf 'create table public.remote_probe (id bigint primary key);\n' >supabase/migrations/20990101000002_remote_probe.sql
if sb db push --remote >"$LOG" 2>&1; then fail "db push --remote applied without confirmation"; fi
grep -q -- "--yes" "$LOG" || fail "db push --remote asked for no confirmation: $(cat "$LOG")"
run sb db push --remote --yes
grep -q "Finished supabase db push" "$LOG" || fail "db push --remote --yes did not finish"
[ "$(rest 'remote_probe?select=id' -o /dev/null -w '%{http_code}')" = 200 ] || fail "db push --remote applied no remote_probe table"
# With the profile pointing nowhere the linked path fails and the local one still answers: they do not share a route.
sed 's#^api_url: .*#api_url: http://127.0.0.1:9#' "$WORK/spark-profile.yaml" >"$WORK/dead-profile.yaml"
export SUPABASE_PROFILE="$WORK/dead-profile.yaml"
if sb migration list --remote >"$LOG" 2>&1; then fail "migration list --remote answered with the Management API unreachable"; fi
run sb migration list
grep -q "20990101000002" "$LOG" || fail "migration list on the local target does not show the pushed migration"
export SUPABASE_PROFILE="$WORK/spark-profile.yaml"
ok "linked project ($PROJECT_REF through $API): link, db query --read-only (a write asks for --yes), migration list, gen types, db diff and a confirmed db push through the Management API; unreachable, only the local target answers"

run sb stop
# Anchored: an unanchored match also finds any shell whose command line names the binary.
pgrep -af "^$SPARK_BIN( |\$)" >&2 && fail "spark still running after stop"
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/rest/v1/" || true)
[ "$code" = 000 ] || fail "the API still answers after stop (HTTP $code)"
ok "supabase stop: nothing left running"
printf '\nE2E OK\n'
