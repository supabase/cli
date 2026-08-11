# Exposed for updates by .github/dependabot.yml
FROM supabase/postgres:17.6.1.158 AS pg
# Append to ServiceImages when adding new dependencies below
FROM library/kong:2.8.1 AS kong
FROM axllent/mailpit:v1.30.2 AS mailpit
FROM postgrest/postgrest:v16.0 AS postgrest
FROM supabase/postgres-meta:v0.96.8 AS pgmeta
FROM supabase/studio:2026.08.10-sha-5b68af1 AS studio
FROM darthsim/imgproxy:v3.8.0 AS imgproxy
FROM supabase/edge-runtime:v1.74.3 AS edgeruntime
FROM timberio/vector:0.53.0-alpine AS vector
FROM supabase/supavisor:2.9.7 AS supavisor
FROM supabase/gotrue:v2.195.0 AS gotrue
FROM supabase/realtime:v2.124.3 AS realtime
FROM supabase/storage-api:v1.68.15 AS storage
FROM supabase/logflare:1.50.1 AS logflare
# Append to JobImages when adding new dependencies below
FROM supabase/pgadmin-schema-diff:cli-0.0.5 AS differ
FROM supabase/migra:3.0.1663481299 AS migra
FROM supabase/pg_prove:3.36 AS pgprove
