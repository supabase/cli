# Exposed for updates by .github/dependabot.yml
FROM supabase/postgres:17.6.1.171 AS pg
# New always-on service alias: extend SERVICE_IMAGE_ALIASES in
# shared/services/services.shared.ts and DOCKERFILE_ALIAS_BY_SERVICE in
# commands/start/start.gates.ts.
FROM library/kong:2.8.1 AS kong
FROM axllent/mailpit:v1.30.2 AS mailpit
FROM postgrest/postgrest:v16.3 AS postgrest
FROM supabase/postgres-meta:v0.99.0 AS pgmeta
FROM supabase/studio:2026.09.14-sha-4dd8a95 AS studio
FROM darthsim/imgproxy:v3.8.0 AS imgproxy
FROM supabase/edge-runtime:v1.76.2 AS edgeruntime
FROM timberio/vector:0.53.0-alpine AS vector
FROM supabase/supavisor:2.9.13 AS supavisor
FROM supabase/gotrue:v2.197.0 AS gotrue
FROM supabase/realtime:v2.135.3 AS realtime
FROM supabase/storage-api:v1.77.0 AS storage
FROM supabase/logflare:1.50.12 AS logflare
# One-shot job images (not started as long-running containers); differ's alias
# is resolved via dockerfileServiceImage("differ") in commands/db/diff/pgadmin-diff.ts.
FROM supabase/pgadmin-schema-diff:cli-0.0.5 AS differ
FROM supabase/migra:3.0.1663481299 AS migra
FROM supabase/pg_prove:3.36 AS pgprove
