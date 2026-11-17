#!/usr/bin/env bash
# End-to-end check of the experimental Spark backend: a project opts in through config.toml, and
# start runs Spark, its meta adapter and Studio on the native stack; then supabase-js with auth and
# RLS, Studio, the Supabase MCP server, db pull/diff/push/reset, unsupported SQL and stop.
# Needs: a Spark binary (SUPABASE_SPARK_BIN), the PoC example apps (SPARK_EXAMPLE_DIR, with
# `bun install` run), a built Supabase MCP server (SUPABASE_MCP_CLI), bun, node, jq, curl, python3.
# SUPABASE_CLI_BIN runs a compiled CLI instead of the source. Uses ports 54321 and 54323.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CLI_MAIN="$HERE/../src/main.ts"
# Defaults expect the spark and mcp checkouts next to this repository.
SIBLINGS="$(cd "$HERE/../../../.." && pwd)"
SPARK_BIN="${SUPABASE_SPARK_BIN:-$SIBLINGS/spark/target/release/spark}"
EXAMPLE="${SPARK_EXAMPLE_DIR:-$SIBLINGS/spark/poc/supabase-spark-dev/example}"
MCP_CLI="${SUPABASE_MCP_CLI:-$SIBLINGS/mcp/packages/mcp-server-supabase/dist/cli.js}"
export SUPABASE_NO_UPDATE_NOTIFIER=1 SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
WORK="$(mktemp -d)"
PROJECT="$WORK/spark-todos"
API=http://127.0.0.1:54321
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
  found="$( (docker ps --format '{{.Image}} {{.Names}}' 2>/dev/null || true; pgrep -a postgres || true) | grep -Ei 'postgres' || true)"
  [ -z "$found" ] || fail "Postgres is running: $found"
}

for tool in bun node jq curl python3; do command -v "$tool" >/dev/null || fail "missing $tool"; done
[ -x "$SPARK_BIN" ] || fail "no spark binary at $SPARK_BIN"
[ -d "$EXAMPLE/node_modules" ] || fail "run bun install in $EXAMPLE"
[ -f "$MCP_CLI" ] || fail "no Supabase MCP server at $MCP_CLI"
ok "setup: spark, bun, node, the MCP server and the example apps are ready"

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
ok "supabase start: Spark, its meta adapter and Studio on the native stack (no Postgres)"

run sb status
grep -q "$API" "$LOG" && grep -q "spark" "$LOG" || fail "supabase status printed no Spark stack"
ANON_KEY="$(key ANON_KEY)"
SERVICE_KEY="$(key SERVICE_ROLE_KEY)"
[ -n "$ANON_KEY" ] && [ -n "$SERVICE_KEY" ] || fail "supabase status --env printed no keys"
ok "supabase status reports the Spark stack and its keys"

check app.test.mjs
ok "app (supabase-js): sign up, CRUD and RLS isolation on todos"

check studio.check.mjs
no_postgres
ok "Studio: table editor rows, create table and insert row from the UI, policies page, SQL editor"

mkdir -p "$WORK/mcp-check"
ln -s "$EXAMPLE/node_modules" "$WORK/mcp-check/node_modules"
sed -e "s#command: 'bun', args: \[new URL('../spark-dev.ts', import.meta.url).pathname, 'mcp'\]#command: 'node', args: [process.env.MCP_CLI, '--access-token', 'local', '--project-ref', 'default', '--api-url', '$API', '--features', 'database,development']#" \
  "$EXAMPLE/mcp.check.mjs" >"$WORK/mcp-check/mcp.check.mjs"
grep -q "process.env.MCP_CLI" "$WORK/mcp-check/mcp.check.mjs" || fail "cannot point the MCP check at the MCP server"
run env ANON_KEY="$ANON_KEY" MCP_CLI="$MCP_CLI" node "$WORK/mcp-check/mcp.check.mjs"
ls supabase/migrations/*_add_labels.sql >/dev/null 2>&1 || fail "apply_migration wrote no migration file"
ok "MCP: list_tables, apply_migration, execute_sql, list_migrations, generate_typescript_types, get_project_url"

run sb gen types typescript --local
grep -q "todos:" "$LOG" || fail "gen types has no todos table"
ok "gen types typescript --local from Spark's schema description"

run sb db pull
[ -f supabase/schemas/public/tables/todos.sql ] || fail "db pull wrote no supabase/schemas/public/tables/todos.sql"
grep -rqi 'create policy "Users manage their own todos"' supabase/schemas || fail "db pull exported no todos policy"
ok "db pull exports the schema, with Spark's native RLS policies, to supabase/schemas"

out="$(sb db diff -f noop 2>"$LOG")" || fail "db diff -f noop"
[ "$out" = "No schema changes found" ] || fail "db diff -f noop: $out"
ok "db diff on the unchanged export: No schema changes found"

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
grep -q "Proof: OK" "$LOG" || fail "db diff -f add_projects: no \"Proof: OK\""
ls supabase/migrations/*_add_projects.sql >/dev/null 2>&1 || fail "no add_projects migration file"
ok "edit schema files (new column, projects table with FK, RLS policy, index); db diff -f add_projects: Proof: OK"

run sb db push
grep -q "Finished supabase db push" "$LOG" || fail "db push did not finish"
policies="$(curl -s "$API/pg/policies?included_schemas=public" | jq -r '.[].name')"
for policy in "Owners manage projects" "Users manage their own todos"; do
  grep -qx "$policy" <<<"$policies" || fail "pg-meta lists no \"$policy\" policy after push: $policies"
done
[ "$(rest 'todos?select=id' | jq length)" = "$todos_before" ] || fail "db push lost todos rows"
ok "db push applies the migration (dry run first), existing rows kept ($todos_before todos); pg-meta lists both policies"

code=$(rest 'todos?select=priority' -o /dev/null -w '%{http_code}')
[ "$code" = 200 ] || fail "GET todos?select=priority: HTTP $code"
check feature.check.mjs
fk=$(rest projects -XPOST -H 'content-type: application/json' -d '{"name":"orphan","owner_id":"00000000-0000-0000-0000-000000000000"}' | jq -r .code)
[ "$fk" = 23503 ] || fail "the projects foreign key is not enforced (got $fk)"
ok "app: the new column and the projects table work over REST (RLS, foreign key enforced)"

out="$(sb db diff -f again 2>"$LOG")" || fail "db diff -f again"
[ "$out" = "No schema changes found" ] || fail "db diff after push: $out"
ok "db diff after push: No schema changes found"

cat > supabase/schemas/public/functions.sql <<'SQL'
create function public.add(a int, b int) returns int
  language plpgsql as $$ begin return a + b; end $$;
SQL
if sb db diff -f with_function >"$LOG" 2>&1; then fail "a schema file with a function was accepted"; fi
grep -Eq 'functions\.sql:[0-9]+' "$LOG" || fail "the rejection names no file:line"
ok "an unsupported function in a schema file is rejected: $(grep -m1 -Eo 'public/functions\.sql:[0-9]+.{0,90}' "$LOG")"
rm supabase/schemas/public/functions.sql

for cmd in "db dump" "db lint" "inspect db table-stats" "test db"; do
  # shellcheck disable=SC2086
  if sb $cmd >"$LOG" 2>&1; then fail "supabase $cmd succeeded on Spark"; fi
  grep -q "not supported on the experimental Spark backend" "$LOG" || fail "supabase $cmd: no clear message"
done
ok "db dump, db lint, inspect db and test db fail with \"not supported on the experimental Spark backend\""

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

run sb stop
# A spark process can outlive stop briefly (see the stop race in the PoC's docs/GAPS.md); allow 3 s.
for _ in 1 2 3 4 5 6; do pgrep -f "$SPARK_BIN" >/dev/null || break; sleep 0.5; done
pgrep -af "$SPARK_BIN" >&2 && fail "spark still running 3 s after stop"
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/rest/v1/" || true)
[ "$code" = 000 ] || fail "the API still answers after stop (HTTP $code)"
ok "supabase stop: nothing left running"
printf '\nE2E OK\n'
