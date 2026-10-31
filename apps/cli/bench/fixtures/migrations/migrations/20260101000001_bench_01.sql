create table public.bench_items (
  id bigint generated always as identity primary key,
  label text not null,
  amount numeric not null,
  created_at timestamptz not null default now()
);
create index bench_items_label_idx on public.bench_items (label);
