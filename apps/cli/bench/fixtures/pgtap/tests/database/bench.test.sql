begin;
select plan(4);
select has_table('public', 'bench_checks', 'bench_checks exists');
select has_column('public', 'bench_checks', 'label', 'label column exists');
select col_not_null('public', 'bench_checks', 'label', 'label is required');
select col_is_pk('public', 'bench_checks', 'id', 'id is the primary key');
select * from finish();
rollback;
