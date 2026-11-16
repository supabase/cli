create table public.bench_checks (
  id bigint generated always as identity primary key,
  label text not null
);
