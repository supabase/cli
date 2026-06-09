# Exposed for updates by .github/dependabot.yml
FROM supabase/postgres:17.6.1.132 AS pg
# Append to ServiceImages when adding new dependencies below
FROM library/kong:2.8.1 AS kong
FROM axllent/mailpit:v1.22.3 AS mailpit
FROM postgrest/postgrest:v14.13 AS postgrest
FROM supabase/postgres-meta:v0.96.6 AS pgmeta
FROM supabase/studio:2026.06.08-sha-8af2bb0 AS studio
FROM darthsim/imgproxy:v3.8.0 AS imgproxy
FROM supabase/edge-runtime:v1.74.0 AS edgeruntime
FROM timberio/vector:0.53.0-alpine AS vector
FROM supabase/supavisor:2.9.7 AS supavisor
FROM supabase/gotrue:v2.189.0 AS gotrue
FROM supabase/realtime:v2.105.0 AS realtime
FROM supabase/storage-api:v1.60.11 AS storage
FROM supabase/logflare:1.43.4 AS logflare
# Append to JobImages when adding new dependencies below
FROM supabase/pgadmin-schema-diff:cli-0.0.5 AS differ
FROM supabase/migra:3.0.1663481299 AS migra
FROM supabase/pg_prove:3.36 AS pgprove
