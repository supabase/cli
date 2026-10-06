# The tag pinned below is generated from packages/stack/src/Artifacts.ts by
# apps/cli/scripts/render-service-dockerfile.ts, for these aliases only: pg, pg15, mailpit,
# postgrest, pgmeta, studio, imgproxy, edgeruntime, vector, supavisor, gotrue, realtime, storage,
# logflare. Do not hand-edit those tags; a CI drift check enforces this. Run the generator after
# a catalog update. Everything else in this file (this comment, kong, pg14, the one-shot job
# images) is hand- or Dependabot-managed. Keep a line between image lines: git conflicts on edits to
# adjacent lines, and catalog PRs for neighbouring aliases are often open at the same time.
FROM supabase/postgres:17.11.0.004 AS pg

FROM supabase/postgres:15.19.0.004 AS pg15
# Postgres 14 has no slim build; bumped by hand (Dependabot ignores supabase/postgres).
FROM supabase/postgres:14.1.0.89 AS pg14
# New always-on service alias: extend SERVICE_IMAGE_ALIASES in
# shared/services/services.shared.ts and DOCKERFILE_ALIAS_BY_SERVICE in
# commands/start/start.gates.ts.
FROM library/kong:2.8.1 AS kong

FROM axllent/mailpit:v1.31.3 AS mailpit

FROM postgrest/postgrest:v16.4 AS postgrest

FROM supabase/postgres-meta:v0.100.0 AS pgmeta

FROM supabase/studio:2026.10.05-sha-94b8b06 AS studio

FROM darthsim/imgproxy:v3.26.0 AS imgproxy

FROM supabase/edge-runtime:v1.77.4 AS edgeruntime

FROM timberio/vector:0.58.0-alpine AS vector

FROM supabase/supavisor:2.9.13 AS supavisor

FROM supabase/gotrue:v2.197.0 AS gotrue

FROM supabase/realtime:v2.140.10 AS realtime

FROM supabase/storage-api:v1.79.34 AS storage

FROM supabase/logflare:1.52.0 AS logflare
# One-shot job images (not started as long-running containers); differ's alias
# is resolved via dockerfileServiceImage("differ") in commands/db/diff/pgadmin-diff.ts.
FROM supabase/pgadmin-schema-diff:cli-0.0.5 AS differ

FROM supabase/migra:3.0.1663481299 AS migra

FROM supabase/pg_prove:3.36 AS pgprove
