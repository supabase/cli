-- List user defined schemas, excluding
--  Extension created schemas
--  Supabase managed schemas
select pn.nspname
from pg_namespace pn
left join pg_depend pd on pd.objid = pn.oid
where pd.deptype is null
  and not pn.nspname like any($1)
  and pn.nspowner::regrole::text != 'supabase_admin'
order by pn.nspname
