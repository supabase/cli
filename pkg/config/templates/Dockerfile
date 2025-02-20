# Exposed for updates by .github/dependabot.yml
FROM supabase/postgres:15.8.1.020 AS pg15
# Append to ServiceImages when adding new dependencies below
FROM library/kong:2.8.1 AS kong
FROM inbucket/inbucket:3.0.3 AS inbucket
FROM postgrest/postgrest:v12.2.0 AS postgrest
FROM supabase/postgres-meta:v0.84.2 AS pgmeta
FROM supabase/studio:20250219-7101314 AS studio
FROM darthsim/imgproxy:v3.8.0 AS imgproxy
FROM supabase/edge-runtime:v1.67.2 AS edgeruntime
FROM timberio/vector:0.28.1-alpine AS vector
FROM supabase/supavisor:1.1.56 AS supavisor
FROM supabase/gotrue:v2.167.0 AS gotrue
FROM supabase/realtime:v2.34.7 AS realtime
FROM supabase/storage-api:v1.19.1 AS storage
FROM supabase/logflare:1.4.0 AS logflare
# Append to JobImages when adding new dependencies below
FROM supabase/pgadmin-schema-diff:cli-0.0.5 AS differ
FROM supabase/migra:3.0.1663481299 AS migra
FROM supabase/pg_prove:3.36 AS pgprove
