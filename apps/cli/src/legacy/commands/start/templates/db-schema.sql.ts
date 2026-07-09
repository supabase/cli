/**
 * Transcribed verbatim from `apps/cli-go/internal/db/start/templates/schema.sql`
 * (Go `//go:embed templates/schema.sql`, `apps/cli-go/internal/db/start/start.go:33-35`).
 * Not a Go `text/template` — embedded byte-for-byte into the Postgres
 * container's entrypoint heredoc (`NewContainerConfig`, `start.go:63-116`) for
 * PG >= 15. Do not hand-edit — re-transcribe from the Go source if it changes.
 */
export const LEGACY_START_DB_SCHEMA_SQL = `\\set pgpass \`echo "$PGPASSWORD"\`
\\set jwt_secret \`echo "$JWT_SECRET"\`
\\set jwt_exp \`echo "$JWT_EXP"\`

ALTER DATABASE postgres SET "app.settings.jwt_secret" TO :'jwt_secret';
ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';

ALTER USER postgres WITH PASSWORD :'pgpass';
ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER pgbouncer WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_replication_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_read_only_user WITH PASSWORD :'pgpass';

create schema if not exists _realtime;
alter schema _realtime owner to postgres;
`;
