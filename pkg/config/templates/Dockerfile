# Exposed for updates by .github/dependabot.yml
FROM supabase/postgres:17.6.1.105 AS pg
# Append to ServiceImages when adding new dependencies below
FROM library/kong:2.8.1 AS kong
FROM axllent/mailpit:v1.22.3 AS mailpit
FROM postgrest/postgrest:v14.8 AS postgrest
FROM supabase/postgres-meta:v0.96.4 AS pgmeta
FROM supabase/studio:2026.04.08-sha-205cbe7 AS studio
FROM darthsim/imgproxy:v3.8.0 AS imgproxy
FROM supabase/edge-runtime:v1.73.3 AS edgeruntime
FROM timberio/vector:0.53.0-alpine AS vector
FROM supabase/supavisor:2.7.4 AS supavisor
FROM supabase/gotrue:v2.188.1 AS gotrue
FROM supabase/realtime:v2.83.0 AS realtime
FROM supabase/storage-api:v1.48.30 AS storage
FROM supabase/logflare:1.37.2 AS logflare
# Append to JobImages when adding new dependencies below
FROM supabase/pgadmin-schema-diff:cli-0.0.5 AS differ
FROM supabase/migra:3.0.1663481299 AS migra
FROM supabase/pg_prove:3.36 AS pgprove
