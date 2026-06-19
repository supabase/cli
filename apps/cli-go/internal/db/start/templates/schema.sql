\set pgpass `echo "$PGPASSWORD"`
\set jwt_secret `echo "$JWT_SECRET"`
\set jwt_exp `echo "$JWT_EXP"`

ALTER DATABASE postgres SET "app.settings.jwt_secret" TO :'jwt_secret';
ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';

ALTER USER postgres WITH PASSWORD :'pgpass';
ALTER USER authenticator WITH PASSWORD :'pgpass';
ALTER USER pgbouncer WITH PASSWORD :'pgpass';
ALTER USER supabase_auth_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_storage_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_replication_admin WITH PASSWORD :'pgpass';
ALTER USER supabase_read_only_user WITH PASSWORD :'pgpass';

-- supabase_realtime_admin is created by realtime's own tenant migrations on first
-- boot, so it does not exist in the base image. Create it up front (idempotently)
-- so realtime can authenticate as a least-privileged user from the start.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
    CREATE ROLE supabase_realtime_admin WITH NOINHERIT CREATEROLE LOGIN REPLICATION;
  END IF;
END
$$;
ALTER USER supabase_realtime_admin WITH PASSWORD :'pgpass';

create schema if not exists _realtime;
alter schema _realtime owner to postgres;
