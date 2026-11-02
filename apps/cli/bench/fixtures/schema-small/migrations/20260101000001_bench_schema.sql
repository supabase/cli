create table public.bench_table_001 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_001_owner_idx on public.bench_table_001 (owner_id);
create index bench_table_001_status_idx on public.bench_table_001 (status, created_at);
alter table public.bench_table_001 enable row level security;
create policy bench_table_001_read on public.bench_table_001 for select using (true);

create table public.bench_table_002 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_002_owner_idx on public.bench_table_002 (owner_id);
create index bench_table_002_status_idx on public.bench_table_002 (status, created_at);
alter table public.bench_table_002 enable row level security;
create policy bench_table_002_read on public.bench_table_002 for select using (true);

create table public.bench_table_003 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_003_owner_idx on public.bench_table_003 (owner_id);
create index bench_table_003_status_idx on public.bench_table_003 (status, created_at);
alter table public.bench_table_003 enable row level security;
create policy bench_table_003_read on public.bench_table_003 for select using (true);

create table public.bench_table_004 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_004_owner_idx on public.bench_table_004 (owner_id);
create index bench_table_004_status_idx on public.bench_table_004 (status, created_at);
alter table public.bench_table_004 enable row level security;
create policy bench_table_004_read on public.bench_table_004 for select using (true);

create table public.bench_table_005 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_005_owner_idx on public.bench_table_005 (owner_id);
create index bench_table_005_status_idx on public.bench_table_005 (status, created_at);
alter table public.bench_table_005 enable row level security;
create policy bench_table_005_read on public.bench_table_005 for select using (true);

create view public.bench_table_005_summary as
  select status, count(*) as total from public.bench_table_005 group by status;

create table public.bench_table_006 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_006_owner_idx on public.bench_table_006 (owner_id);
create index bench_table_006_status_idx on public.bench_table_006 (status, created_at);
alter table public.bench_table_006 enable row level security;
create policy bench_table_006_read on public.bench_table_006 for select using (true);

create table public.bench_table_007 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_007_owner_idx on public.bench_table_007 (owner_id);
create index bench_table_007_status_idx on public.bench_table_007 (status, created_at);
alter table public.bench_table_007 enable row level security;
create policy bench_table_007_read on public.bench_table_007 for select using (true);

create table public.bench_table_008 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_008_owner_idx on public.bench_table_008 (owner_id);
create index bench_table_008_status_idx on public.bench_table_008 (status, created_at);
alter table public.bench_table_008 enable row level security;
create policy bench_table_008_read on public.bench_table_008 for select using (true);

create table public.bench_table_009 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_009_owner_idx on public.bench_table_009 (owner_id);
create index bench_table_009_status_idx on public.bench_table_009 (status, created_at);
alter table public.bench_table_009 enable row level security;
create policy bench_table_009_read on public.bench_table_009 for select using (true);

create table public.bench_table_010 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_010_owner_idx on public.bench_table_010 (owner_id);
create index bench_table_010_status_idx on public.bench_table_010 (status, created_at);
alter table public.bench_table_010 enable row level security;
create policy bench_table_010_read on public.bench_table_010 for select using (true);

create view public.bench_table_010_summary as
  select status, count(*) as total from public.bench_table_010 group by status;

create function public.bench_table_010_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_010 $$;
