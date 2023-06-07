do $$ declare
  rec record;
begin
  -- functions
  for rec in
    select *
    from pg_proc p
    where p.pronamespace::regnamespace::name = 'public'
  loop
    -- supports aggregate, function, and procedure
    execute format('drop routine if exists %I.%I(%s) cascade', rec.pronamespace::regnamespace::name, rec.proname, pg_catalog.pg_get_function_identity_arguments(rec.oid));
  end loop;

  -- in order: tables (cascade to views), sequences
  for rec in
    select *
    from pg_class c
    where
      c.relnamespace::regnamespace::name = 'public'
      and c.relkind not in ('c', 'v', 'm')
    order by c.relkind desc
  loop
    -- supports all kinds of relations, except views and complex types
    execute format('drop table if exists %I.%I cascade', rec.relnamespace::regnamespace::name, rec.relname);
  end loop;

  -- types
  for rec in
    select *
    from pg_type t
    where t.typnamespace::regnamespace::name = 'public'
  loop
    execute format('drop type if exists %I.%I cascade', rec.typnamespace::regnamespace::name, rec.typname);
  end loop;
end $$;
