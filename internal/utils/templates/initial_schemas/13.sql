--
-- 00-initial-schema.sql
--

-- Set up reatime 
-- create publication supabase_realtime; -- defaults to empty publication
create publication supabase_realtime;

-- Supabase super admin
-- create user supabase_admin;
-- alter user  supabase_admin with superuser createdb createrole replication bypassrls;

-- Extension namespacing
create SCHEMA IF NOT exists extensions;
create extension if not exists "uuid-ossp"      with schema extensions;
create extension if not exists pgcrypto         with schema extensions;
create extension if not exists pgjwt            with schema extensions;

-- Set up auth roles for the developer
-- create role anon                nologin noinherit;
-- create role authenticated       nologin noinherit; -- "logged in" user: web_user, app_user, etc
-- create role service_role        nologin noinherit bypassrls; -- allow developers to create JWT's that bypass their policies

-- create user authenticator noinherit;
-- grant anon              to authenticator;
-- grant authenticated     to authenticator;
-- grant service_role      to authenticator;
-- grant supabase_admin    to authenticator;

grant usage                     on schema public to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to postgres, anon, authenticated, service_role;

-- Allow Extensions to be used in the API
grant usage                     on schema extensions to postgres, anon, authenticated, service_role;

-- Set up namespacing
-- alter user supabase_admin SET search_path TO public, extensions; -- don't include the "auth" schema

-- These are required so that the users receive grants whenever "supabase_admin" creates tables/function
alter default privileges for user supabase_admin in schema public grant all
    on sequences to postgres, anon, authenticated, service_role;
alter default privileges for user supabase_admin in schema public grant all
    on tables to postgres, anon, authenticated, service_role;
alter default privileges for user supabase_admin in schema public grant all
    on functions to postgres, anon, authenticated, service_role;

-- Set short statement/query timeouts for API roles
-- alter role anon set statement_timeout = '3s';
-- alter role authenticated set statement_timeout = '8s';

--
-- auth-schema.sql
--

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_admin;

-- auth.users definition

CREATE TABLE auth.users (
	instance_id uuid NULL,
	id uuid NOT NULL UNIQUE,
	aud varchar(255) NULL,
	"role" varchar(255) NULL,
	email varchar(255) NULL UNIQUE,
	encrypted_password varchar(255) NULL,
	confirmed_at timestamptz NULL,
	invited_at timestamptz NULL,
	confirmation_token varchar(255) NULL,
	confirmation_sent_at timestamptz NULL,
	recovery_token varchar(255) NULL,
	recovery_sent_at timestamptz NULL,
	email_change_token varchar(255) NULL,
	email_change varchar(255) NULL,
	email_change_sent_at timestamptz NULL,
	last_sign_in_at timestamptz NULL,
	raw_app_meta_data jsonb NULL,
	raw_user_meta_data jsonb NULL,
	is_super_admin bool NULL,
	created_at timestamptz NULL,
	updated_at timestamptz NULL,
	CONSTRAINT users_pkey PRIMARY KEY (id)
);
CREATE INDEX users_instance_id_email_idx ON auth.users USING btree (instance_id, email);
CREATE INDEX users_instance_id_idx ON auth.users USING btree (instance_id);
comment on table auth.users is 'Auth: Stores user login data within a secure schema.';

-- auth.refresh_tokens definition

CREATE TABLE auth.refresh_tokens (
	instance_id uuid NULL,
	id bigserial NOT NULL,
	"token" varchar(255) NULL,
	user_id varchar(255) NULL,
	revoked bool NULL,
	created_at timestamptz NULL,
	updated_at timestamptz NULL,
	CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id)
);
CREATE INDEX refresh_tokens_instance_id_idx ON auth.refresh_tokens USING btree (instance_id);
CREATE INDEX refresh_tokens_instance_id_user_id_idx ON auth.refresh_tokens USING btree (instance_id, user_id);
CREATE INDEX refresh_tokens_token_idx ON auth.refresh_tokens USING btree (token);
comment on table auth.refresh_tokens is 'Auth: Store of tokens used to refresh JWT tokens once they expire.';

-- auth.instances definition

CREATE TABLE auth.instances (
	id uuid NOT NULL,
	uuid uuid NULL,
	raw_base_config text NULL,
	created_at timestamptz NULL,
	updated_at timestamptz NULL,
	CONSTRAINT instances_pkey PRIMARY KEY (id)
);
comment on table auth.instances is 'Auth: Manages users across multiple sites.';

-- auth.audit_log_entries definition

CREATE TABLE auth.audit_log_entries (
	instance_id uuid NULL,
	id uuid NOT NULL,
	payload json NULL,
	created_at timestamptz NULL,
	CONSTRAINT audit_log_entries_pkey PRIMARY KEY (id)
);
CREATE INDEX audit_logs_instance_id_idx ON auth.audit_log_entries USING btree (instance_id);
comment on table auth.audit_log_entries is 'Auth: Audit trail for user actions.';

-- auth.schema_migrations definition

CREATE TABLE auth.schema_migrations (
	"version" varchar(255) NOT NULL,
	CONSTRAINT schema_migrations_pkey PRIMARY KEY ("version")
);
comment on table auth.schema_migrations is 'Auth: Manages updates to the auth system.';

INSERT INTO auth.schema_migrations (version)
VALUES  ('20171026211738'),
        ('20171026211808'),
        ('20171026211834'),
        ('20180103212743'),
        ('20180108183307'),
        ('20180119214651'),
        ('20180125194653');
		
-- Gets the User ID from the request cookie
create or replace function auth.uid() returns uuid as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$ language sql stable;

-- Gets the User ID from the request cookie
create or replace function auth.role() returns text as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')::text;
$$ language sql stable;

-- Gets the User email
create or replace function auth.email() returns text as $$
  select nullif(current_setting('request.jwt.claim.email', true), '')::text;
$$ language sql stable;

-- usage on auth functions to API roles
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

-- Supabase super admin
-- CREATE USER supabase_auth_admin NOINHERIT CREATEROLE LOGIN NOREPLICATION;
GRANT ALL PRIVILEGES ON SCHEMA auth TO supabase_auth_admin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA auth TO supabase_auth_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA auth TO supabase_auth_admin;
-- ALTER USER supabase_auth_admin SET search_path = "auth";
ALTER table "auth".users OWNER TO supabase_auth_admin;
ALTER table "auth".refresh_tokens OWNER TO supabase_auth_admin;
ALTER table "auth".audit_log_entries OWNER TO supabase_auth_admin;
ALTER table "auth".instances OWNER TO supabase_auth_admin;
ALTER table "auth".schema_migrations OWNER TO supabase_auth_admin;

--
-- storage-schema.sql
--

CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION supabase_admin;

grant usage on schema storage to postgres, anon, authenticated, service_role;
alter default privileges in schema storage grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema storage grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema storage grant all on sequences to postgres, anon, authenticated, service_role;

CREATE TABLE "storage"."buckets" (
    "id" text not NULL,
    "name" text NOT NULL,
    "owner" uuid,
    "created_at" timestamptz DEFAULT now(),
    "updated_at" timestamptz DEFAULT now(),
    CONSTRAINT "buckets_owner_fkey" FOREIGN KEY ("owner") REFERENCES "auth"."users"("id"),
    PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bname" ON "storage"."buckets" USING BTREE ("name");

CREATE TABLE "storage"."objects" (
    "id" uuid NOT NULL DEFAULT extensions.uuid_generate_v4(),
    "bucket_id" text,
    "name" text,
    "owner" uuid,
    "created_at" timestamptz DEFAULT now(),
    "updated_at" timestamptz DEFAULT now(),
    "last_accessed_at" timestamptz DEFAULT now(),
    "metadata" jsonb,
    CONSTRAINT "objects_bucketId_fkey" FOREIGN KEY ("bucket_id") REFERENCES "storage"."buckets"("id"),
    CONSTRAINT "objects_owner_fkey" FOREIGN KEY ("owner") REFERENCES "auth"."users"("id"),
    PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "bucketid_objname" ON "storage"."objects" USING BTREE ("bucket_id","name");
CREATE INDEX name_prefix_search ON storage.objects(name text_pattern_ops);

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION storage.foldername(name text)
 RETURNS text[]
 LANGUAGE plpgsql
AS $function$
DECLARE
_parts text[];
BEGIN
	select string_to_array(name, '/') into _parts;
	return _parts[1:array_length(_parts,1)-1];
END
$function$;

CREATE FUNCTION storage.filename(name text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
_parts text[];
BEGIN
	select string_to_array(name, '/') into _parts;
	return _parts[array_length(_parts,1)];
END
$function$;

CREATE FUNCTION storage.extension(name text)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE
_parts text[];
_filename text;
BEGIN
	select string_to_array(name, '/') into _parts;
	select _parts[array_length(_parts,1)] into _filename;
	-- @todo return the last part instead of 2
	return split_part(_filename, '.', 2);
END
$function$;

CREATE FUNCTION storage.search(prefix text, bucketname text, limits int DEFAULT 100, levels int DEFAULT 1, offsets int DEFAULT 0)
 RETURNS TABLE (
    name text,
    id uuid,
    updated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ,
    last_accessed_at TIMESTAMPTZ,
    metadata jsonb
  )
 LANGUAGE plpgsql
AS $function$
DECLARE
_bucketId text;
BEGIN
    -- will be replaced by migrations when server starts
    RAISE 'Storage Tenant not ready. Please contact Supabase Support.';
END
$function$;

-- create migrations table
-- https://github.com/ThomWright/postgres-migrations/blob/master/src/migrations/0_create-migrations-table.sql
-- we add this table here and not let it be auto-created so that the permissions are properly applied to it
CREATE TABLE IF NOT EXISTS storage.migrations (
  id integer PRIMARY KEY,
  name varchar(100) UNIQUE NOT NULL,
  hash varchar(40) NOT NULL, -- sha1 hex encoded hash of the file name and contents, to ensure it hasn't been altered since applying the migration
  executed_at timestamp DEFAULT current_timestamp
);

-- CREATE USER supabase_storage_admin NOINHERIT CREATEROLE LOGIN NOREPLICATION;
GRANT ALL PRIVILEGES ON SCHEMA storage TO supabase_storage_admin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA storage TO supabase_storage_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA storage TO supabase_storage_admin;
-- ALTER USER supabase_storage_admin SET search_path = "storage";
ALTER table "storage".objects owner to supabase_storage_admin;
ALTER table "storage".buckets owner to supabase_storage_admin;
ALTER table "storage".migrations OWNER TO supabase_storage_admin;
ALTER function "storage".foldername(text) owner to supabase_storage_admin;
ALTER function "storage".filename(text) owner to supabase_storage_admin;
ALTER function "storage".extension(text) owner to supabase_storage_admin;
ALTER function "storage".search(text,text,int,int,int) owner to supabase_storage_admin;

--
-- post-setup.sql
--

-- ALTER ROLE postgres SET search_path TO "\$user",public,extensions;

-- Trigger for pg_cron
CREATE OR REPLACE FUNCTION extensions.grant_pg_cron_access()
RETURNS event_trigger
LANGUAGE plpgsql
AS $$
DECLARE
  schema_is_cron bool;
BEGIN
  schema_is_cron = (
    SELECT n.nspname = 'cron'
    FROM pg_event_trigger_ddl_commands() AS ev
    LEFT JOIN pg_catalog.pg_namespace AS n
      ON ev.objid = n.oid
  );

  IF schema_is_cron
  THEN
    grant usage on schema cron to postgres with grant option;

    alter default privileges in schema cron grant all on tables to postgres with grant option;
    alter default privileges in schema cron grant all on functions to postgres with grant option;
    alter default privileges in schema cron grant all on sequences to postgres with grant option;

    alter default privileges for user supabase_admin in schema cron grant all
        on sequences to postgres with grant option;
    alter default privileges for user supabase_admin in schema cron grant all
        on tables to postgres with grant option;
    alter default privileges for user supabase_admin in schema cron grant all
        on functions to postgres with grant option;

    grant all privileges on all tables in schema cron to postgres with grant option; 

  END IF;

END;
$$;
CREATE EVENT TRIGGER issue_pg_cron_access ON ddl_command_end WHEN TAG in ('CREATE SCHEMA')
EXECUTE PROCEDURE extensions.grant_pg_cron_access();
COMMENT ON FUNCTION extensions.grant_pg_cron_access IS 'Grants access to pg_cron';

-- Event trigger for pg_net
CREATE OR REPLACE FUNCTION extensions.grant_pg_net_access()
RETURNS event_trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_event_trigger_ddl_commands() AS ev
    JOIN pg_extension AS ext
    ON ev.objid = ext.oid
    WHERE ext.extname = 'pg_net'
  )
  THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_roles
      WHERE rolname = 'supabase_functions_admin'
    )
    THEN
      CREATE USER supabase_functions_admin NOINHERIT CREATEROLE LOGIN NOREPLICATION;
    END IF;

    GRANT USAGE ON SCHEMA net TO supabase_functions_admin, postgres, anon, authenticated, service_role;

    ALTER function net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) SECURITY DEFINER;
    ALTER function net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) SECURITY DEFINER;
    ALTER function net.http_collect_response(request_id bigint, async boolean) SECURITY DEFINER;

    ALTER function net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) SET search_path = net;
    ALTER function net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) SET search_path = net;
    ALTER function net.http_collect_response(request_id bigint, async boolean) SET search_path = net;

    REVOKE ALL ON FUNCTION net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) FROM PUBLIC;
    REVOKE ALL ON FUNCTION net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) FROM PUBLIC;
    REVOKE ALL ON FUNCTION net.http_collect_response(request_id bigint, async boolean) FROM PUBLIC;

    GRANT EXECUTE ON FUNCTION net.http_get(url text, params jsonb, headers jsonb, timeout_milliseconds integer) TO supabase_functions_admin, postgres, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION net.http_post(url text, body jsonb, params jsonb, headers jsonb, timeout_milliseconds integer) TO supabase_functions_admin, postgres, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION net.http_collect_response(request_id bigint, async boolean) TO supabase_functions_admin, postgres, anon, authenticated, service_role;
  END IF;
END;
$$;
COMMENT ON FUNCTION extensions.grant_pg_net_access IS 'Grants access to pg_net';

DO
$$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_event_trigger
    WHERE evtname = 'issue_pg_net_access'
  ) THEN
    CREATE EVENT TRIGGER issue_pg_net_access
    ON ddl_command_end
    WHEN TAG IN ('CREATE EXTENSION')
    EXECUTE PROCEDURE extensions.grant_pg_net_access();
  END IF;
END
$$;

-- Supabase dashboard user
-- CREATE ROLE dashboard_user NOSUPERUSER CREATEDB CREATEROLE REPLICATION;
GRANT ALL ON DATABASE postgres TO dashboard_user;
GRANT ALL ON SCHEMA auth TO dashboard_user;
GRANT ALL ON SCHEMA extensions TO dashboard_user;
GRANT ALL ON SCHEMA storage TO dashboard_user;
GRANT ALL ON ALL TABLES IN SCHEMA auth TO dashboard_user;
GRANT ALL ON ALL TABLES IN SCHEMA extensions TO dashboard_user;
-- GRANT ALL ON ALL TABLES IN SCHEMA storage TO dashboard_user;
GRANT ALL ON ALL SEQUENCES IN SCHEMA auth TO dashboard_user;
GRANT ALL ON ALL SEQUENCES IN SCHEMA storage TO dashboard_user;
GRANT ALL ON ALL SEQUENCES IN SCHEMA extensions TO dashboard_user;
GRANT ALL ON ALL ROUTINES IN SCHEMA auth TO dashboard_user;
GRANT ALL ON ALL ROUTINES IN SCHEMA storage TO dashboard_user;
GRANT ALL ON ALL ROUTINES IN SCHEMA extensions TO dashboard_user;

-- demote postgres user
GRANT ALL ON DATABASE postgres TO postgres;
GRANT ALL ON SCHEMA auth TO postgres;
GRANT ALL ON SCHEMA extensions TO postgres;
GRANT ALL ON SCHEMA storage TO postgres;
GRANT ALL ON ALL TABLES IN SCHEMA auth TO postgres;
GRANT ALL ON ALL TABLES IN SCHEMA storage TO postgres;
GRANT ALL ON ALL TABLES IN SCHEMA extensions TO postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA auth TO postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA storage TO postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA extensions TO postgres;
GRANT ALL ON ALL ROUTINES IN SCHEMA auth TO postgres;
GRANT ALL ON ALL ROUTINES IN SCHEMA storage TO postgres;
GRANT ALL ON ALL ROUTINES IN SCHEMA extensions TO postgres;
-- ALTER ROLE postgres NOSUPERUSER CREATEDB CREATEROLE LOGIN REPLICATION BYPASSRLS;

--
-- Ad-hoc
--

SET ROLE supabase_admin;

--
-- 20211115181400-update-auth-permissions.sql
--

-- update auth schema permissions
GRANT ALL PRIVILEGES ON SCHEMA auth TO supabase_auth_admin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA auth TO supabase_auth_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA auth TO supabase_auth_admin;

ALTER table IF EXISTS "auth".users OWNER TO supabase_auth_admin;
ALTER table IF EXISTS "auth".refresh_tokens OWNER TO supabase_auth_admin;
ALTER table IF EXISTS "auth".audit_log_entries OWNER TO supabase_auth_admin;
ALTER table IF EXISTS "auth".instances OWNER TO supabase_auth_admin;
ALTER table IF EXISTS "auth".schema_migrations OWNER TO supabase_auth_admin;

GRANT USAGE ON SCHEMA auth TO postgres;
GRANT ALL ON ALL TABLES IN SCHEMA auth TO postgres, dashboard_user;
GRANT ALL ON ALL SEQUENCES IN SCHEMA auth TO postgres, dashboard_user;
GRANT ALL ON ALL ROUTINES IN SCHEMA auth TO postgres, dashboard_user;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON TABLES TO postgres, dashboard_user;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON SEQUENCES TO postgres, dashboard_user;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON ROUTINES TO postgres, dashboard_user;

--
-- 20211118015519-create-realtime-schema.sql
--

-- create realtime schema for Realtime RLS (WALRUS)
CREATE SCHEMA IF NOT EXISTS realtime;

--
-- 20211122051245-update-realtime-permissions.sql
--

-- update realtime schema permissions
GRANT USAGE ON SCHEMA realtime TO postgres;
GRANT ALL ON ALL TABLES IN SCHEMA realtime TO postgres, dashboard_user;
GRANT ALL ON ALL SEQUENCES IN SCHEMA realtime TO postgres, dashboard_user;
GRANT ALL ON ALL ROUTINES IN SCHEMA realtime TO postgres, dashboard_user;

--
-- 20211124212715-update-auth-owner.sql
--

-- update owner for auth.uid, auth.role and auth.email functions
ALTER FUNCTION auth.uid owner to supabase_auth_admin;
ALTER FUNCTION auth.role owner to supabase_auth_admin;
ALTER FUNCTION auth.email owner to supabase_auth_admin;

--
-- 20211130151719-update-realtime-permissions.sql
--

-- Update future objects' permissions
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT ALL ON TABLES TO postgres, dashboard_user;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT ALL ON SEQUENCES TO postgres, dashboard_user;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT ALL ON ROUTINES TO postgres, dashboard_user;

--
-- 20220126121436-finer-postgrest-triggers.sql
--

drop event trigger if exists api_restart;
drop function if exists extensions.notify_api_restart();

-- https://postgrest.org/en/latest/schema_cache.html#finer-grained-event-trigger
-- watch create and alter
CREATE OR REPLACE FUNCTION extensions.pgrst_ddl_watch() RETURNS event_trigger AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    IF cmd.command_tag IN (
      'CREATE SCHEMA', 'ALTER SCHEMA'
    , 'CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE'
    , 'CREATE FOREIGN TABLE', 'ALTER FOREIGN TABLE'
    , 'CREATE VIEW', 'ALTER VIEW'
    , 'CREATE MATERIALIZED VIEW', 'ALTER MATERIALIZED VIEW'
    , 'CREATE FUNCTION', 'ALTER FUNCTION'
    , 'CREATE TRIGGER'
    , 'CREATE TYPE'
    , 'CREATE RULE'
    , 'COMMENT'
    )
    -- don't notify in case of CREATE TEMP table or other objects created on pg_temp
    AND cmd.schema_name is distinct from 'pg_temp'
    THEN
      NOTIFY pgrst, 'reload schema';
    END IF;
  END LOOP;
END; $$ LANGUAGE plpgsql;

-- watch drop
CREATE OR REPLACE FUNCTION extensions.pgrst_drop_watch() RETURNS event_trigger AS $$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects()
  LOOP
    IF obj.object_type IN (
      'schema'
    , 'table'
    , 'foreign table'
    , 'view'
    , 'materialized view'
    , 'function'
    , 'trigger'
    , 'type'
    , 'rule'
    )
    AND obj.is_temporary IS false -- no pg_temp objects
    THEN
      NOTIFY pgrst, 'reload schema';
    END IF;
  END LOOP;
END; $$ LANGUAGE plpgsql;

CREATE EVENT TRIGGER pgrst_ddl_watch
  ON ddl_command_end
  EXECUTE PROCEDURE extensions.pgrst_ddl_watch();

CREATE EVENT TRIGGER pgrst_drop_watch
  ON sql_drop
  EXECUTE PROCEDURE extensions.pgrst_drop_watch();

--
-- 20220317095840_pg_graphql.sql
--

create schema if not exists graphql_public;

-- GraphQL Placeholder Entrypoint
create or replace function graphql_public.graphql(
	"operationName" text default null,
	query text default null,
	variables jsonb default null,
	extensions jsonb default null
)
    returns jsonb
    language plpgsql
as $$
    DECLARE
        server_version float;
    BEGIN
        server_version = (SELECT (SPLIT_PART((select version()), ' ', 2))::float);

        IF server_version >= 14 THEN
            RETURN jsonb_build_object(
                'data', null::jsonb,
                'errors', array['pg_graphql extension is not enabled.']
            );
        ELSE
   	        RETURN jsonb_build_object(
                'data', null::jsonb,
                'errors', array['pg_graphql is only available on projects running Postgres 14 onwards.']
            );
        END IF;
    END;
$$;

grant usage on schema graphql_public to postgres, anon, authenticated, service_role;
alter default privileges in schema graphql_public grant all on tables to postgres, anon, authenticated, service_role;
alter default privileges in schema graphql_public grant all on functions to postgres, anon, authenticated, service_role;
alter default privileges in schema graphql_public grant all on sequences to postgres, anon, authenticated, service_role;

alter default privileges for user supabase_admin in schema graphql_public grant all
    on sequences to postgres, anon, authenticated, service_role;
alter default privileges for user supabase_admin in schema graphql_public grant all
    on tables to postgres, anon, authenticated, service_role;
alter default privileges for user supabase_admin in schema graphql_public grant all
    on functions to postgres, anon, authenticated, service_role;

-- Trigger upon enabling pg_graphql
CREATE OR REPLACE FUNCTION extensions.grant_pg_graphql_access()
RETURNS event_trigger
LANGUAGE plpgsql
AS $func$
    DECLARE
    func_is_graphql_resolve bool;
    BEGIN
    func_is_graphql_resolve = (
        SELECT n.proname = 'resolve'
        FROM pg_event_trigger_ddl_commands() AS ev
        LEFT JOIN pg_catalog.pg_proc AS n
        ON ev.objid = n.oid
    );

    IF func_is_graphql_resolve
    THEN
        grant usage on schema graphql to postgres, anon, authenticated, service_role;
        grant all on function graphql.resolve to postgres, anon, authenticated, service_role;

        alter default privileges in schema graphql grant all on tables to postgres, anon, authenticated, service_role;
        alter default privileges in schema graphql grant all on functions to postgres, anon, authenticated, service_role;
        alter default privileges in schema graphql grant all on sequences to postgres, anon, authenticated, service_role;

        create or replace function graphql_public.graphql(
            "operationName" text default null,
            query text default null,
            variables jsonb default null,
            extensions jsonb default null 
        )
            returns jsonb
            language sql
        as $$
            SELECT graphql.resolve(query, coalesce(variables, '{}'));
        $$;

        grant select on graphql.field, graphql.type, graphql.enum_value to postgres, anon, authenticated, service_role;
        grant execute on function graphql.resolve to postgres, anon, authenticated, service_role;
    END IF;

    END;
$func$;

CREATE EVENT TRIGGER issue_pg_graphql_access ON ddl_command_end WHEN TAG in ('CREATE FUNCTION')
EXECUTE PROCEDURE extensions.grant_pg_graphql_access();
COMMENT ON FUNCTION extensions.grant_pg_graphql_access IS 'Grants access to pg_graphql';

-- Trigger upon dropping the pg_graphql extension
CREATE OR REPLACE FUNCTION extensions.set_graphql_placeholder()
RETURNS event_trigger
LANGUAGE plpgsql
AS $func$
    DECLARE
    graphql_is_dropped bool;
    BEGIN
    graphql_is_dropped = (
        SELECT ev.schema_name = 'graphql_public'
        FROM pg_event_trigger_dropped_objects() AS ev
        WHERE ev.schema_name = 'graphql_public'
    );

    IF graphql_is_dropped
    THEN
        create or replace function graphql_public.graphql(
            "operationName" text default null,
            query text default null,
            variables jsonb default null,
            extensions jsonb default null
        )
            returns jsonb
            language plpgsql
        as $$
            DECLARE
                server_version float;
            BEGIN
                server_version = (SELECT (SPLIT_PART((select version()), ' ', 2))::float);

                IF server_version >= 14 THEN
                    RETURN jsonb_build_object(
                        'data', null::jsonb,
                        'errors', array['pg_graphql extension is not enabled.']
                    );
                ELSE
                    RETURN jsonb_build_object(
                        'data', null::jsonb,
                        'errors', array['pg_graphql is only available on projects running Postgres 14 onwards.']
                    );
                END IF;
            END;
        $$;
    END IF;

    END;
$func$;

CREATE EVENT TRIGGER issue_graphql_placeholder ON sql_drop WHEN TAG in ('DROP EXTENSION')
EXECUTE PROCEDURE extensions.set_graphql_placeholder();
COMMENT ON FUNCTION extensions.set_graphql_placeholder IS 'Reintroduces placeholder function for graphql_public.graphql';

--
-- 20220321174452-fix-postgrest-alter-type-event-trigger.sql
--

drop event trigger if exists api_restart;
drop function if exists extensions.notify_api_restart();

-- https://postgrest.org/en/latest/schema_cache.html#finer-grained-event-trigger
-- watch create and alter
CREATE OR REPLACE FUNCTION extensions.pgrst_ddl_watch() RETURNS event_trigger AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands()
  LOOP
    IF cmd.command_tag IN (
      'CREATE SCHEMA', 'ALTER SCHEMA'
    , 'CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE'
    , 'CREATE FOREIGN TABLE', 'ALTER FOREIGN TABLE'
    , 'CREATE VIEW', 'ALTER VIEW'
    , 'CREATE MATERIALIZED VIEW', 'ALTER MATERIALIZED VIEW'
    , 'CREATE FUNCTION', 'ALTER FUNCTION'
    , 'CREATE TRIGGER'
    , 'CREATE TYPE', 'ALTER TYPE'
    , 'CREATE RULE'
    , 'COMMENT'
    )
    -- don't notify in case of CREATE TEMP table or other objects created on pg_temp
    AND cmd.schema_name is distinct from 'pg_temp'
    THEN
      NOTIFY pgrst, 'reload schema';
    END IF;
  END LOOP;
END; $$ LANGUAGE plpgsql;

-- watch drop
CREATE OR REPLACE FUNCTION extensions.pgrst_drop_watch() RETURNS event_trigger AS $$
DECLARE
  obj record;
BEGIN
  FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects()
  LOOP
    IF obj.object_type IN (
      'schema'
    , 'table'
    , 'foreign table'
    , 'view'
    , 'materialized view'
    , 'function'
    , 'trigger'
    , 'type'
    , 'rule'
    )
    AND obj.is_temporary IS false -- no pg_temp objects
    THEN
      NOTIFY pgrst, 'reload schema';
    END IF;
  END LOOP;
END; $$ LANGUAGE plpgsql;

-- CREATE EVENT TRIGGER pgrst_ddl_watch
--   ON ddl_command_end
--   EXECUTE PROCEDURE extensions.pgrst_ddl_watch();

-- CREATE EVENT TRIGGER pgrst_drop_watch
--   ON sql_drop
--   EXECUTE PROCEDURE extensions.pgrst_drop_watch();

--
-- 20220404205710-pg_graphql-on-by-default.sql
--

-- Update Trigger upon enabling pg_graphql
create or replace function extensions.grant_pg_graphql_access()
    returns event_trigger
    language plpgsql
AS $func$
DECLARE
    func_is_graphql_resolve bool;
BEGIN
    func_is_graphql_resolve = (
        SELECT n.proname = 'resolve'
        FROM pg_event_trigger_ddl_commands() AS ev
        LEFT JOIN pg_catalog.pg_proc AS n
        ON ev.objid = n.oid
    );

    IF func_is_graphql_resolve
    THEN
        grant usage on schema graphql to postgres, anon, authenticated, service_role;
        grant all on function graphql.resolve to postgres, anon, authenticated, service_role;

        alter default privileges in schema graphql grant all on tables to postgres, anon, authenticated, service_role;
        alter default privileges in schema graphql grant all on functions to postgres, anon, authenticated, service_role;
        alter default privileges in schema graphql grant all on sequences to postgres, anon, authenticated, service_role;

        -- Update public wrapper to pass all arguments through to the pg_graphql resolve func
        create or replace function graphql_public.graphql(
            "operationName" text default null,
            query text default null,
            variables jsonb default null,
            extensions jsonb default null
        )
            returns jsonb
            language sql
        as $$
            -- This changed
            select graphql.resolve(
                query := query,
                variables := coalesce(variables, '{}'),
                "operationName" := "operationName",
                extensions := extensions
            );
        $$;

        grant select on graphql.field, graphql.type, graphql.enum_value to postgres, anon, authenticated, service_role;
        grant execute on function graphql.resolve to postgres, anon, authenticated, service_role;
    END IF;

END;
$func$;

CREATE OR REPLACE FUNCTION extensions.set_graphql_placeholder()
RETURNS event_trigger
LANGUAGE plpgsql
AS $func$
    DECLARE
    graphql_is_dropped bool;
    BEGIN
    graphql_is_dropped = (
        SELECT ev.schema_name = 'graphql_public'
        FROM pg_event_trigger_dropped_objects() AS ev
        WHERE ev.schema_name = 'graphql_public'
    );

    IF graphql_is_dropped
    THEN
        create or replace function graphql_public.graphql(
            "operationName" text default null,
            query text default null,
            variables jsonb default null,
            extensions jsonb default null
        )
            returns jsonb
            language plpgsql
        as $$
            DECLARE
                server_version float;
            BEGIN
                server_version = (SELECT (SPLIT_PART((select version()), ' ', 2))::float);

                IF server_version >= 14 THEN
                    RETURN jsonb_build_object(
                        'errors', jsonb_build_array(
                            jsonb_build_object(
                                'message', 'pg_graphql extension is not enabled.'
                            )
                        )
                    );
                ELSE
                    RETURN jsonb_build_object(
                        'errors', jsonb_build_array(
                            jsonb_build_object(
                                'message', 'pg_graphql is only available on projects running Postgres 14 onwards.'
                            )
                        )
                    );
                END IF;
            END;
        $$;
    END IF;

    END;
$func$;

-- GraphQL Placeholder Entrypoint
create or replace function graphql_public.graphql(
	"operationName" text default null,
	query text default null,
	variables jsonb default null,
	extensions jsonb default null
)
    returns jsonb
    language plpgsql
as $$
    DECLARE
        server_version float;
    BEGIN
        server_version = (SELECT (SPLIT_PART((select version()), ' ', 2))::float);

        IF server_version >= 14 THEN
            RETURN jsonb_build_object(
                'errors', jsonb_build_array(
                    jsonb_build_object(
                        'message', 'pg_graphql extension is not enabled.'
                    )
                )
            );
        ELSE
   	        RETURN jsonb_build_object(
                'errors', jsonb_build_array(
                    jsonb_build_object(
                        'message', 'pg_graphql is only available on projects running Postgres 14 onwards.'
                    )
                )
            );
        END IF;
    END;
$$;


-- drop extension if exists pg_graphql;
-- Avoids limitation of only being able to load the extension via dashboard
-- create extension if not exists pg_graphql;
