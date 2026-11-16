insert into public.bench_items (label, amount)
select 'item-' || n, (n % 97) * 1.5 from generate_series(1, 1000) as n;
