create table public.bench_table_015 (
  id uuid primary key default gen_random_uuid(),
  item_id bigint references public.bench_items (id),
  note text not null default ''
);
create index bench_table_015_item_idx on public.bench_table_015 (item_id);
