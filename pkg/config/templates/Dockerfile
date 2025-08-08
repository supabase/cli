# Exposed for updates by .github/dependabot.yml
FROM supabase/postgres:17.4.1.071 AS pg
# Append to ServiceImages when adding new dependencies below
FROM library/kong:2.8.1 AS kong
FROM axllent/mailpit:v1.22.3 AS mailpit
FROM postgrest/postgrest:v13.0.4 AS postgrest
FROM supabase/postgres-meta:v0.91.5 AS pgmeta
FROM supabase/studio:2025.08.04-sha-6e99ca6 AS studio
FROM darthsim/imgproxy:v3.8.0 AS imgproxy
FROM supabase/edge-runtime:v1.68.3 AS edgeruntime
FROM timberio/vector:0.28.1-alpine AS vector
FROM supabase/supavisor:2.6.1 AS supavisor
FROM supabase/gotrue:v2.178.0 AS gotrue
FROM supabase/realtime:v2.41.20 AS realtime
FROM supabase/storage-api:v1.26.3 AS storage
FROM supabase/logflare:1.18.3 AS logflare
# Append to JobImages when adding new dependencies below
FROM supabase/pgadmin-schema-diff:cli-0.0.5 AS differ
FROM supabase/migra:3.0.1663481299 AS migra
FROM supabase/pg_prove:3.36 AS pgprove
