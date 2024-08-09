package config

const (
	pg13Image = "supabase/postgres:13.3.0"
	pg14Image = "supabase/postgres:14.1.0.89"
	Pg15Image = "supabase/postgres:15.1.1.78"
	// Append to ServiceImages when adding new dependencies below
	// TODO: try https://github.com/axllent/mailpit
	kongImage        = "library/kong:2.8.1"
	inbucketImage    = "inbucket/inbucket:3.0.3"
	postgrestImage   = "postgrest/postgrest:v12.2.0"
	pgmetaImage      = "supabase/postgres-meta:v0.83.2"
	studioImage      = "supabase/studio:20240729-ce42139"
	imageProxyImage  = "darthsim/imgproxy:v3.8.0"
	edgeRuntimeImage = "supabase/edge-runtime:v1.56.0"
	vectorImage      = "timberio/vector:0.28.1-alpine"
	supavisorImage   = "supabase/supavisor:1.1.56"
	gotrueImage      = "supabase/gotrue:v2.158.1"
	realtimeImage    = "supabase/realtime:v2.30.23"
	storageImage     = "supabase/storage-api:v1.0.6"
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
