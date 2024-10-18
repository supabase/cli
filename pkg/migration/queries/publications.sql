-- List user defined publications
select pubname from pg_publication where pubname not like any($1)