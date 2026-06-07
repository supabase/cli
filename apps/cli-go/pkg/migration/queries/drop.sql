do $$ declare
  rec record;
begin
  -- schemas
  for rec in
    select pn.*
    from pg_namespace pn
    left join pg_depend pd on pd.objid = pn.oid
    where pd.deptype is null
      and not pn.nspname like any(array['information\_schema', 'pg\_%', '\_analytics', '\_realtime', '\_supavisor', 'pgbouncer', 'pgmq', 'pgsodium', 'pgtle', 'supabase\_migrations', 'vault', 'extensions', 'public'])
      and pn.nspowner::regrole::text != 'supabase_admin'
  loop
    -- If an extension uses a schema it doesn't create, dropping the schema will cascade to also
    -- drop the extension. But if an extension creates its own schema, dropping the schema will
    -- throw an error. Hence, we drop schemas first while excluding those created by extensions.
    raise notice 'dropping schema: %', rec.nspname;
    execute format('drop schema if exists %I cascade', rec.nspname);
  end loop;

  -- extensions
  for rec in
    select *
    from pg_extension p
    where p.extname not in ('pg_graphql', 'pg_net', 'pg_stat_statements', 'pgcrypto', 'pgjwt', 'pgsodium', 'plpgsql', 'supabase_vault', 'uuid-ossp')
  loop
    raise notice 'dropping extension: %', rec.extname;
    execute format('drop extension if exists %I cascade', rec.extname);
  end loop;

  -- functions
  for rec in
    select *
    from pg_proc p
    where p.pronamespace::regnamespace::name = 'public'
  loop
    -- supports aggregate, function, and procedure
    raise notice 'dropping function: %.%', rec.pronamespace::regnamespace::name, rec.proname;
    execute format('drop routine if exists %I.%I(%s) cascade', rec.pronamespace::regnamespace::name, rec.proname, pg_catalog.pg_get_function_identity_arguments(rec.oid));
  end loop;

  -- views (necessary for views referencing objects in Supabase-managed schemas)
  for rec in
    select *
    from pg_class c
    where
      c.relnamespace::regnamespace::name = 'public'
      and c.relkind = 'v'
  loop
    raise notice 'dropping view: %.%', rec.relnamespace::regnamespace::name, rec.relname;
    execute format('drop view if exists %I.%I cascade', rec.relnamespace::regnamespace::name, rec.relname);
  end loop;

  -- materialized views (necessary for materialized views referencing objects in Supabase-managed schemas)
  for rec in
    select *
    from pg_class c
    where
      c.relnamespace::regnamespace::name = 'public'
      and c.relkind = 'm'
  loop
    raise notice 'dropping materialized view: %.%', rec.relnamespace::regnamespace::name, rec.relname;
    execute format('drop materialized view if exists %I.%I cascade', rec.relnamespace::regnamespace::name, rec.relname);
  end loop;

  -- tables (cascade to dependent objects)
  for rec in
    select *
    from pg_class c
    where
      c.relnamespace::regnamespace::name = 'public'
      and c.relkind not in ('c', 'S', 'v', 'm')
    order by c.relkind desc
  loop
    -- supports all table like relations, except views, complex types, and sequences
    raise notice 'dropping table: %.%', rec.relnamespace::regnamespace::name, rec.relname;
    execute format('drop table if exists %I.%I cascade', rec.relnamespace::regnamespace::name, rec.relname);
  end loop;

  -- truncate tables in auth, webhooks, and migrations schema
  for rec in
    select *
    from pg_class c
    where
      (c.relnamespace::regnamespace::name = 'auth' and c.relname != 'schema_migrations'
      or c.relnamespace::regnamespace::name = 'supabase_functions' and c.relname != 'migrations'
      or c.relnamespace::regnamespace::name = 'supabase_migrations')
      and c.relkind = 'r'
  loop
    raise notice 'truncating table: %.%', rec.relnamespace::regnamespace::name, rec.relname;
    execute format('truncate %I.%I cascade', rec.relnamespace::regnamespace::name, rec.relname);
  end loop;

  -- sequences
  for rec in
    select *
    from pg_class c
    where
      c.relnamespace::regnamespace::name = 'public'
      and c.relkind = 's'
  loop
    raise notice 'dropping sequence: %.%', rec.relnamespace::regnamespace::name, rec.relname;
    execute format('drop sequence if exists %I.%I cascade', rec.relnamespace::regnamespace::name, rec.relname);
  end loop;

  -- types
  for rec in
    select *
    from pg_type t
    where
      t.typnamespace::regnamespace::name = 'public'
      and typtype != 'b'
  loop
    raise notice 'dropping type: %.%', rec.typnamespace::regnamespace::name, rec.typname;
    execute format('drop type if exists %I.%I cascade', rec.typnamespace::regnamespace::name, rec.typname);
  end loop;

  -- policies
  for rec in
    select *
    from pg_policies p
  loop
    raise notice 'dropping policy: %', rec.policyname;
    execute format('drop policy if exists %I on %I.%I cascade', rec.policyname, rec.schemaname, rec.tablename);
  end loop;

  -- publications
  for rec in
    select *
    from pg_publication p
    where
      not p.pubname like any(array['supabase\_realtime%', 'realtime\_messages%'])
  loop
    raise notice 'dropping publication: %', rec.pubname;
    execute format('drop publication if exists %I', rec.pubname);
  end loop;
end $$;
