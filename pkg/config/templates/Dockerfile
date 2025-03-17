# Exposed for updates by .github/dependabot.yml
FROM supabase/postgres:15.8.1.054 AS pg15
# Append to ServiceImages when adding new dependencies below
FROM library/kong:2.8.1 AS kong
FROM axllent/mailpit:v1.22.3 AS mailpit
FROM postgrest/postgrest:v12.2.8 AS postgrest
FROM supabase/postgres-meta:v0.86.1 AS pgmeta
FROM supabase/studio:20250317-6955350 AS studio
FROM darthsim/imgproxy:v3.8.0 AS imgproxy
FROM supabase/edge-runtime:v1.67.2 AS edgeruntime
FROM timberio/vector:0.28.1-alpine AS vector
FROM supabase/supavisor:2.4.13 AS supavisor
FROM supabase/gotrue:v2.170.0 AS gotrue
FROM supabase/realtime:v2.34.43 AS realtime
FROM supabase/storage-api:v1.19.3 AS storage
FROM supabase/logflare:1.12.0 AS logflare
# Append to JobImages when adding new dependencies below
FROM supabase/pgadmin-schema-diff:cli-0.0.5 AS differ
FROM supabase/migra:3.0.1663481299 AS migra
FROM supabase/pg_prove:3.36 AS pgprove
