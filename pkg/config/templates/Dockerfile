# Exposed for updates by .github/dependabot.yml
FROM supabase/postgres:17.6.1.075 AS pg
# Append to ServiceImages when adding new dependencies below
FROM library/kong:2.8.1 AS kong
FROM axllent/mailpit:v1.22.3 AS mailpit
FROM postgrest/postgrest:v14.3 AS postgrest
FROM supabase/postgres-meta:v0.95.2 AS pgmeta
FROM supabase/studio:2026.01.27-sha-2a37755 AS studio
FROM darthsim/imgproxy:v3.8.0 AS imgproxy
FROM supabase/edge-runtime:v1.70.0 AS edgeruntime
FROM timberio/vector:0.28.1-alpine AS vector
FROM supabase/supavisor:2.7.4 AS supavisor
FROM supabase/gotrue:v2.186.0 AS gotrue
FROM supabase/realtime:v2.73.2 AS realtime
FROM supabase/storage-api:v1.35.3 AS storage
FROM supabase/logflare:1.30.5 AS logflare
# Append to JobImages when adding new dependencies below
FROM supabase/pgadmin-schema-diff:cli-0.0.5 AS differ
FROM supabase/migra:3.0.1663481299 AS migra
FROM supabase/pg_prove:3.36 AS pgprove
