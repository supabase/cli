-- List user defined schemas, excluding
--  Extension created schemas
--  Supabase managed schemas
select pn.nspname
from pg_catalog.pg_namespace pn
left join pg_catalog.pg_depend pd on pd.objid = pn.oid and pd.classid = 'pg_catalog.pg_namespace'::regclass
where pd.deptype is null
  and not pn.nspname like any($1)
  and pn.nspowner::regrole::text != 'supabase_admin'
order by pn.nspname
