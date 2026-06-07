-- Ref: https://github.com/okbob/plpgsql_check#mass-check
SELECT p.proname, plpgsql_check_function(p.oid, format:='json')
FROM pg_catalog.pg_namespace n
JOIN pg_catalog.pg_proc p ON pronamespace = n.oid
JOIN pg_catalog.pg_language l ON p.prolang = l.oid
WHERE l.lanname = 'plpgsql' AND p.prorettype <> 2279 AND n.nspname = $1::text;
