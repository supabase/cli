package config

const (
	pg13Image = "supabase/postgres:13.3.0"
	pg14Image = "supabase/postgres:14.1.0.89"
	Pg15Image = "supabase/postgres:15.6.1.143"
	// Append to ServiceImages when adding new dependencies below
	// TODO: try https://github.com/axllent/mailpit
	kongImage        = "library/kong:2.8.1"
	inbucketImage    = "inbucket/inbucket:3.0.3"
	postgrestImage   = "postgrest/postgrest:v12.2.0"
	pgmetaImage      = "supabase/postgres-meta:v0.84.2"
	studioImage      = "supabase/studio:20241202-71e5240"
	imageProxyImage  = "darthsim/imgproxy:v3.8.0"
	edgeRuntimeImage = "supabase/edge-runtime:v1.65.4"
	vectorImage      = "timberio/vector:0.28.1-alpine"
	supavisorImage   = "supabase/supavisor:1.1.56"
	gotrueImage      = "supabase/gotrue:v2.164.0"
	realtimeImage    = "supabase/realtime:v2.33.58"
	storageImage     = "supabase/storage-api:v1.14.5"
	logflareImage    = "supabase/logflare:1.4.0"
	// Append to JobImages when adding new dependencies below
	DifferImage  = "supabase/pgadmin-schema-diff:cli-0.0.5"
	MigraImage   = "supabase/migra:3.0.1663481299"
	PgProveImage = "supabase/pg_prove:3.36"
)

var ServiceImages = []string{
	gotrueImage,
	realtimeImage,
	storageImage,
	imageProxyImage,
	kongImage,
	inbucketImage,
	postgrestImage,
	pgmetaImage,
	studioImage,
	edgeRuntimeImage,
	logflareImage,
	vectorImage,
	supavisorImage,
}

var JobImages = []string{
	DifferImage,
	MigraImage,
	PgProveImage,
}
