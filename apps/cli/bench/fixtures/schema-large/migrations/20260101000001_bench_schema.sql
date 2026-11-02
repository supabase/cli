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

create table public.bench_table_011 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_011_owner_idx on public.bench_table_011 (owner_id);
create index bench_table_011_status_idx on public.bench_table_011 (status, created_at);
alter table public.bench_table_011 enable row level security;
create policy bench_table_011_read on public.bench_table_011 for select using (true);

create table public.bench_table_012 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_012_owner_idx on public.bench_table_012 (owner_id);
create index bench_table_012_status_idx on public.bench_table_012 (status, created_at);
alter table public.bench_table_012 enable row level security;
create policy bench_table_012_read on public.bench_table_012 for select using (true);

create table public.bench_table_013 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_013_owner_idx on public.bench_table_013 (owner_id);
create index bench_table_013_status_idx on public.bench_table_013 (status, created_at);
alter table public.bench_table_013 enable row level security;
create policy bench_table_013_read on public.bench_table_013 for select using (true);

create table public.bench_table_014 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_014_owner_idx on public.bench_table_014 (owner_id);
create index bench_table_014_status_idx on public.bench_table_014 (status, created_at);
alter table public.bench_table_014 enable row level security;
create policy bench_table_014_read on public.bench_table_014 for select using (true);

create table public.bench_table_015 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_015_owner_idx on public.bench_table_015 (owner_id);
create index bench_table_015_status_idx on public.bench_table_015 (status, created_at);
alter table public.bench_table_015 enable row level security;
create policy bench_table_015_read on public.bench_table_015 for select using (true);

create view public.bench_table_015_summary as
  select status, count(*) as total from public.bench_table_015 group by status;

create table public.bench_table_016 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_016_owner_idx on public.bench_table_016 (owner_id);
create index bench_table_016_status_idx on public.bench_table_016 (status, created_at);
alter table public.bench_table_016 enable row level security;
create policy bench_table_016_read on public.bench_table_016 for select using (true);

create table public.bench_table_017 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_017_owner_idx on public.bench_table_017 (owner_id);
create index bench_table_017_status_idx on public.bench_table_017 (status, created_at);
alter table public.bench_table_017 enable row level security;
create policy bench_table_017_read on public.bench_table_017 for select using (true);

create table public.bench_table_018 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_018_owner_idx on public.bench_table_018 (owner_id);
create index bench_table_018_status_idx on public.bench_table_018 (status, created_at);
alter table public.bench_table_018 enable row level security;
create policy bench_table_018_read on public.bench_table_018 for select using (true);

create table public.bench_table_019 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_019_owner_idx on public.bench_table_019 (owner_id);
create index bench_table_019_status_idx on public.bench_table_019 (status, created_at);
alter table public.bench_table_019 enable row level security;
create policy bench_table_019_read on public.bench_table_019 for select using (true);

create table public.bench_table_020 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_020_owner_idx on public.bench_table_020 (owner_id);
create index bench_table_020_status_idx on public.bench_table_020 (status, created_at);
alter table public.bench_table_020 enable row level security;
create policy bench_table_020_read on public.bench_table_020 for select using (true);

create view public.bench_table_020_summary as
  select status, count(*) as total from public.bench_table_020 group by status;

create function public.bench_table_020_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_020 $$;

create table public.bench_table_021 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_021_owner_idx on public.bench_table_021 (owner_id);
create index bench_table_021_status_idx on public.bench_table_021 (status, created_at);
alter table public.bench_table_021 enable row level security;
create policy bench_table_021_read on public.bench_table_021 for select using (true);

create table public.bench_table_022 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_022_owner_idx on public.bench_table_022 (owner_id);
create index bench_table_022_status_idx on public.bench_table_022 (status, created_at);
alter table public.bench_table_022 enable row level security;
create policy bench_table_022_read on public.bench_table_022 for select using (true);

create table public.bench_table_023 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_023_owner_idx on public.bench_table_023 (owner_id);
create index bench_table_023_status_idx on public.bench_table_023 (status, created_at);
alter table public.bench_table_023 enable row level security;
create policy bench_table_023_read on public.bench_table_023 for select using (true);

create table public.bench_table_024 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_024_owner_idx on public.bench_table_024 (owner_id);
create index bench_table_024_status_idx on public.bench_table_024 (status, created_at);
alter table public.bench_table_024 enable row level security;
create policy bench_table_024_read on public.bench_table_024 for select using (true);

create table public.bench_table_025 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_025_owner_idx on public.bench_table_025 (owner_id);
create index bench_table_025_status_idx on public.bench_table_025 (status, created_at);
alter table public.bench_table_025 enable row level security;
create policy bench_table_025_read on public.bench_table_025 for select using (true);

create view public.bench_table_025_summary as
  select status, count(*) as total from public.bench_table_025 group by status;

create table public.bench_table_026 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_026_owner_idx on public.bench_table_026 (owner_id);
create index bench_table_026_status_idx on public.bench_table_026 (status, created_at);
alter table public.bench_table_026 enable row level security;
create policy bench_table_026_read on public.bench_table_026 for select using (true);

create table public.bench_table_027 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_027_owner_idx on public.bench_table_027 (owner_id);
create index bench_table_027_status_idx on public.bench_table_027 (status, created_at);
alter table public.bench_table_027 enable row level security;
create policy bench_table_027_read on public.bench_table_027 for select using (true);

create table public.bench_table_028 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_028_owner_idx on public.bench_table_028 (owner_id);
create index bench_table_028_status_idx on public.bench_table_028 (status, created_at);
alter table public.bench_table_028 enable row level security;
create policy bench_table_028_read on public.bench_table_028 for select using (true);

create table public.bench_table_029 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_029_owner_idx on public.bench_table_029 (owner_id);
create index bench_table_029_status_idx on public.bench_table_029 (status, created_at);
alter table public.bench_table_029 enable row level security;
create policy bench_table_029_read on public.bench_table_029 for select using (true);

create table public.bench_table_030 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_030_owner_idx on public.bench_table_030 (owner_id);
create index bench_table_030_status_idx on public.bench_table_030 (status, created_at);
alter table public.bench_table_030 enable row level security;
create policy bench_table_030_read on public.bench_table_030 for select using (true);

create view public.bench_table_030_summary as
  select status, count(*) as total from public.bench_table_030 group by status;

create function public.bench_table_030_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_030 $$;

create table public.bench_table_031 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_031_owner_idx on public.bench_table_031 (owner_id);
create index bench_table_031_status_idx on public.bench_table_031 (status, created_at);
alter table public.bench_table_031 enable row level security;
create policy bench_table_031_read on public.bench_table_031 for select using (true);

create table public.bench_table_032 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_032_owner_idx on public.bench_table_032 (owner_id);
create index bench_table_032_status_idx on public.bench_table_032 (status, created_at);
alter table public.bench_table_032 enable row level security;
create policy bench_table_032_read on public.bench_table_032 for select using (true);

create table public.bench_table_033 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_033_owner_idx on public.bench_table_033 (owner_id);
create index bench_table_033_status_idx on public.bench_table_033 (status, created_at);
alter table public.bench_table_033 enable row level security;
create policy bench_table_033_read on public.bench_table_033 for select using (true);

create table public.bench_table_034 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_034_owner_idx on public.bench_table_034 (owner_id);
create index bench_table_034_status_idx on public.bench_table_034 (status, created_at);
alter table public.bench_table_034 enable row level security;
create policy bench_table_034_read on public.bench_table_034 for select using (true);

create table public.bench_table_035 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_035_owner_idx on public.bench_table_035 (owner_id);
create index bench_table_035_status_idx on public.bench_table_035 (status, created_at);
alter table public.bench_table_035 enable row level security;
create policy bench_table_035_read on public.bench_table_035 for select using (true);

create view public.bench_table_035_summary as
  select status, count(*) as total from public.bench_table_035 group by status;

create table public.bench_table_036 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_036_owner_idx on public.bench_table_036 (owner_id);
create index bench_table_036_status_idx on public.bench_table_036 (status, created_at);
alter table public.bench_table_036 enable row level security;
create policy bench_table_036_read on public.bench_table_036 for select using (true);

create table public.bench_table_037 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_037_owner_idx on public.bench_table_037 (owner_id);
create index bench_table_037_status_idx on public.bench_table_037 (status, created_at);
alter table public.bench_table_037 enable row level security;
create policy bench_table_037_read on public.bench_table_037 for select using (true);

create table public.bench_table_038 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_038_owner_idx on public.bench_table_038 (owner_id);
create index bench_table_038_status_idx on public.bench_table_038 (status, created_at);
alter table public.bench_table_038 enable row level security;
create policy bench_table_038_read on public.bench_table_038 for select using (true);

create table public.bench_table_039 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_039_owner_idx on public.bench_table_039 (owner_id);
create index bench_table_039_status_idx on public.bench_table_039 (status, created_at);
alter table public.bench_table_039 enable row level security;
create policy bench_table_039_read on public.bench_table_039 for select using (true);

create table public.bench_table_040 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_040_owner_idx on public.bench_table_040 (owner_id);
create index bench_table_040_status_idx on public.bench_table_040 (status, created_at);
alter table public.bench_table_040 enable row level security;
create policy bench_table_040_read on public.bench_table_040 for select using (true);

create view public.bench_table_040_summary as
  select status, count(*) as total from public.bench_table_040 group by status;

create function public.bench_table_040_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_040 $$;

create table public.bench_table_041 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_041_owner_idx on public.bench_table_041 (owner_id);
create index bench_table_041_status_idx on public.bench_table_041 (status, created_at);
alter table public.bench_table_041 enable row level security;
create policy bench_table_041_read on public.bench_table_041 for select using (true);

create table public.bench_table_042 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_042_owner_idx on public.bench_table_042 (owner_id);
create index bench_table_042_status_idx on public.bench_table_042 (status, created_at);
alter table public.bench_table_042 enable row level security;
create policy bench_table_042_read on public.bench_table_042 for select using (true);

create table public.bench_table_043 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_043_owner_idx on public.bench_table_043 (owner_id);
create index bench_table_043_status_idx on public.bench_table_043 (status, created_at);
alter table public.bench_table_043 enable row level security;
create policy bench_table_043_read on public.bench_table_043 for select using (true);

create table public.bench_table_044 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_044_owner_idx on public.bench_table_044 (owner_id);
create index bench_table_044_status_idx on public.bench_table_044 (status, created_at);
alter table public.bench_table_044 enable row level security;
create policy bench_table_044_read on public.bench_table_044 for select using (true);

create table public.bench_table_045 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_045_owner_idx on public.bench_table_045 (owner_id);
create index bench_table_045_status_idx on public.bench_table_045 (status, created_at);
alter table public.bench_table_045 enable row level security;
create policy bench_table_045_read on public.bench_table_045 for select using (true);

create view public.bench_table_045_summary as
  select status, count(*) as total from public.bench_table_045 group by status;

create table public.bench_table_046 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_046_owner_idx on public.bench_table_046 (owner_id);
create index bench_table_046_status_idx on public.bench_table_046 (status, created_at);
alter table public.bench_table_046 enable row level security;
create policy bench_table_046_read on public.bench_table_046 for select using (true);

create table public.bench_table_047 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_047_owner_idx on public.bench_table_047 (owner_id);
create index bench_table_047_status_idx on public.bench_table_047 (status, created_at);
alter table public.bench_table_047 enable row level security;
create policy bench_table_047_read on public.bench_table_047 for select using (true);

create table public.bench_table_048 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_048_owner_idx on public.bench_table_048 (owner_id);
create index bench_table_048_status_idx on public.bench_table_048 (status, created_at);
alter table public.bench_table_048 enable row level security;
create policy bench_table_048_read on public.bench_table_048 for select using (true);

create table public.bench_table_049 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_049_owner_idx on public.bench_table_049 (owner_id);
create index bench_table_049_status_idx on public.bench_table_049 (status, created_at);
alter table public.bench_table_049 enable row level security;
create policy bench_table_049_read on public.bench_table_049 for select using (true);

create table public.bench_table_050 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_050_owner_idx on public.bench_table_050 (owner_id);
create index bench_table_050_status_idx on public.bench_table_050 (status, created_at);
alter table public.bench_table_050 enable row level security;
create policy bench_table_050_read on public.bench_table_050 for select using (true);

create view public.bench_table_050_summary as
  select status, count(*) as total from public.bench_table_050 group by status;

create function public.bench_table_050_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_050 $$;

create table public.bench_table_051 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_051_owner_idx on public.bench_table_051 (owner_id);
create index bench_table_051_status_idx on public.bench_table_051 (status, created_at);
alter table public.bench_table_051 enable row level security;
create policy bench_table_051_read on public.bench_table_051 for select using (true);

create table public.bench_table_052 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_052_owner_idx on public.bench_table_052 (owner_id);
create index bench_table_052_status_idx on public.bench_table_052 (status, created_at);
alter table public.bench_table_052 enable row level security;
create policy bench_table_052_read on public.bench_table_052 for select using (true);

create table public.bench_table_053 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_053_owner_idx on public.bench_table_053 (owner_id);
create index bench_table_053_status_idx on public.bench_table_053 (status, created_at);
alter table public.bench_table_053 enable row level security;
create policy bench_table_053_read on public.bench_table_053 for select using (true);

create table public.bench_table_054 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_054_owner_idx on public.bench_table_054 (owner_id);
create index bench_table_054_status_idx on public.bench_table_054 (status, created_at);
alter table public.bench_table_054 enable row level security;
create policy bench_table_054_read on public.bench_table_054 for select using (true);

create table public.bench_table_055 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_055_owner_idx on public.bench_table_055 (owner_id);
create index bench_table_055_status_idx on public.bench_table_055 (status, created_at);
alter table public.bench_table_055 enable row level security;
create policy bench_table_055_read on public.bench_table_055 for select using (true);

create view public.bench_table_055_summary as
  select status, count(*) as total from public.bench_table_055 group by status;

create table public.bench_table_056 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_056_owner_idx on public.bench_table_056 (owner_id);
create index bench_table_056_status_idx on public.bench_table_056 (status, created_at);
alter table public.bench_table_056 enable row level security;
create policy bench_table_056_read on public.bench_table_056 for select using (true);

create table public.bench_table_057 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_057_owner_idx on public.bench_table_057 (owner_id);
create index bench_table_057_status_idx on public.bench_table_057 (status, created_at);
alter table public.bench_table_057 enable row level security;
create policy bench_table_057_read on public.bench_table_057 for select using (true);

create table public.bench_table_058 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_058_owner_idx on public.bench_table_058 (owner_id);
create index bench_table_058_status_idx on public.bench_table_058 (status, created_at);
alter table public.bench_table_058 enable row level security;
create policy bench_table_058_read on public.bench_table_058 for select using (true);

create table public.bench_table_059 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_059_owner_idx on public.bench_table_059 (owner_id);
create index bench_table_059_status_idx on public.bench_table_059 (status, created_at);
alter table public.bench_table_059 enable row level security;
create policy bench_table_059_read on public.bench_table_059 for select using (true);

create table public.bench_table_060 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_060_owner_idx on public.bench_table_060 (owner_id);
create index bench_table_060_status_idx on public.bench_table_060 (status, created_at);
alter table public.bench_table_060 enable row level security;
create policy bench_table_060_read on public.bench_table_060 for select using (true);

create view public.bench_table_060_summary as
  select status, count(*) as total from public.bench_table_060 group by status;

create function public.bench_table_060_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_060 $$;

create table public.bench_table_061 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_061_owner_idx on public.bench_table_061 (owner_id);
create index bench_table_061_status_idx on public.bench_table_061 (status, created_at);
alter table public.bench_table_061 enable row level security;
create policy bench_table_061_read on public.bench_table_061 for select using (true);

create table public.bench_table_062 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_062_owner_idx on public.bench_table_062 (owner_id);
create index bench_table_062_status_idx on public.bench_table_062 (status, created_at);
alter table public.bench_table_062 enable row level security;
create policy bench_table_062_read on public.bench_table_062 for select using (true);

create table public.bench_table_063 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_063_owner_idx on public.bench_table_063 (owner_id);
create index bench_table_063_status_idx on public.bench_table_063 (status, created_at);
alter table public.bench_table_063 enable row level security;
create policy bench_table_063_read on public.bench_table_063 for select using (true);

create table public.bench_table_064 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_064_owner_idx on public.bench_table_064 (owner_id);
create index bench_table_064_status_idx on public.bench_table_064 (status, created_at);
alter table public.bench_table_064 enable row level security;
create policy bench_table_064_read on public.bench_table_064 for select using (true);

create table public.bench_table_065 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_065_owner_idx on public.bench_table_065 (owner_id);
create index bench_table_065_status_idx on public.bench_table_065 (status, created_at);
alter table public.bench_table_065 enable row level security;
create policy bench_table_065_read on public.bench_table_065 for select using (true);

create view public.bench_table_065_summary as
  select status, count(*) as total from public.bench_table_065 group by status;

create table public.bench_table_066 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_066_owner_idx on public.bench_table_066 (owner_id);
create index bench_table_066_status_idx on public.bench_table_066 (status, created_at);
alter table public.bench_table_066 enable row level security;
create policy bench_table_066_read on public.bench_table_066 for select using (true);

create table public.bench_table_067 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_067_owner_idx on public.bench_table_067 (owner_id);
create index bench_table_067_status_idx on public.bench_table_067 (status, created_at);
alter table public.bench_table_067 enable row level security;
create policy bench_table_067_read on public.bench_table_067 for select using (true);

create table public.bench_table_068 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_068_owner_idx on public.bench_table_068 (owner_id);
create index bench_table_068_status_idx on public.bench_table_068 (status, created_at);
alter table public.bench_table_068 enable row level security;
create policy bench_table_068_read on public.bench_table_068 for select using (true);

create table public.bench_table_069 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_069_owner_idx on public.bench_table_069 (owner_id);
create index bench_table_069_status_idx on public.bench_table_069 (status, created_at);
alter table public.bench_table_069 enable row level security;
create policy bench_table_069_read on public.bench_table_069 for select using (true);

create table public.bench_table_070 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_070_owner_idx on public.bench_table_070 (owner_id);
create index bench_table_070_status_idx on public.bench_table_070 (status, created_at);
alter table public.bench_table_070 enable row level security;
create policy bench_table_070_read on public.bench_table_070 for select using (true);

create view public.bench_table_070_summary as
  select status, count(*) as total from public.bench_table_070 group by status;

create function public.bench_table_070_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_070 $$;

create table public.bench_table_071 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_071_owner_idx on public.bench_table_071 (owner_id);
create index bench_table_071_status_idx on public.bench_table_071 (status, created_at);
alter table public.bench_table_071 enable row level security;
create policy bench_table_071_read on public.bench_table_071 for select using (true);

create table public.bench_table_072 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_072_owner_idx on public.bench_table_072 (owner_id);
create index bench_table_072_status_idx on public.bench_table_072 (status, created_at);
alter table public.bench_table_072 enable row level security;
create policy bench_table_072_read on public.bench_table_072 for select using (true);

create table public.bench_table_073 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_073_owner_idx on public.bench_table_073 (owner_id);
create index bench_table_073_status_idx on public.bench_table_073 (status, created_at);
alter table public.bench_table_073 enable row level security;
create policy bench_table_073_read on public.bench_table_073 for select using (true);

create table public.bench_table_074 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_074_owner_idx on public.bench_table_074 (owner_id);
create index bench_table_074_status_idx on public.bench_table_074 (status, created_at);
alter table public.bench_table_074 enable row level security;
create policy bench_table_074_read on public.bench_table_074 for select using (true);

create table public.bench_table_075 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_075_owner_idx on public.bench_table_075 (owner_id);
create index bench_table_075_status_idx on public.bench_table_075 (status, created_at);
alter table public.bench_table_075 enable row level security;
create policy bench_table_075_read on public.bench_table_075 for select using (true);

create view public.bench_table_075_summary as
  select status, count(*) as total from public.bench_table_075 group by status;

create table public.bench_table_076 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_076_owner_idx on public.bench_table_076 (owner_id);
create index bench_table_076_status_idx on public.bench_table_076 (status, created_at);
alter table public.bench_table_076 enable row level security;
create policy bench_table_076_read on public.bench_table_076 for select using (true);

create table public.bench_table_077 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_077_owner_idx on public.bench_table_077 (owner_id);
create index bench_table_077_status_idx on public.bench_table_077 (status, created_at);
alter table public.bench_table_077 enable row level security;
create policy bench_table_077_read on public.bench_table_077 for select using (true);

create table public.bench_table_078 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_078_owner_idx on public.bench_table_078 (owner_id);
create index bench_table_078_status_idx on public.bench_table_078 (status, created_at);
alter table public.bench_table_078 enable row level security;
create policy bench_table_078_read on public.bench_table_078 for select using (true);

create table public.bench_table_079 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_079_owner_idx on public.bench_table_079 (owner_id);
create index bench_table_079_status_idx on public.bench_table_079 (status, created_at);
alter table public.bench_table_079 enable row level security;
create policy bench_table_079_read on public.bench_table_079 for select using (true);

create table public.bench_table_080 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_080_owner_idx on public.bench_table_080 (owner_id);
create index bench_table_080_status_idx on public.bench_table_080 (status, created_at);
alter table public.bench_table_080 enable row level security;
create policy bench_table_080_read on public.bench_table_080 for select using (true);

create view public.bench_table_080_summary as
  select status, count(*) as total from public.bench_table_080 group by status;

create function public.bench_table_080_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_080 $$;

create table public.bench_table_081 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_081_owner_idx on public.bench_table_081 (owner_id);
create index bench_table_081_status_idx on public.bench_table_081 (status, created_at);
alter table public.bench_table_081 enable row level security;
create policy bench_table_081_read on public.bench_table_081 for select using (true);

create table public.bench_table_082 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_082_owner_idx on public.bench_table_082 (owner_id);
create index bench_table_082_status_idx on public.bench_table_082 (status, created_at);
alter table public.bench_table_082 enable row level security;
create policy bench_table_082_read on public.bench_table_082 for select using (true);

create table public.bench_table_083 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_083_owner_idx on public.bench_table_083 (owner_id);
create index bench_table_083_status_idx on public.bench_table_083 (status, created_at);
alter table public.bench_table_083 enable row level security;
create policy bench_table_083_read on public.bench_table_083 for select using (true);

create table public.bench_table_084 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_084_owner_idx on public.bench_table_084 (owner_id);
create index bench_table_084_status_idx on public.bench_table_084 (status, created_at);
alter table public.bench_table_084 enable row level security;
create policy bench_table_084_read on public.bench_table_084 for select using (true);

create table public.bench_table_085 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_085_owner_idx on public.bench_table_085 (owner_id);
create index bench_table_085_status_idx on public.bench_table_085 (status, created_at);
alter table public.bench_table_085 enable row level security;
create policy bench_table_085_read on public.bench_table_085 for select using (true);

create view public.bench_table_085_summary as
  select status, count(*) as total from public.bench_table_085 group by status;

create table public.bench_table_086 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_086_owner_idx on public.bench_table_086 (owner_id);
create index bench_table_086_status_idx on public.bench_table_086 (status, created_at);
alter table public.bench_table_086 enable row level security;
create policy bench_table_086_read on public.bench_table_086 for select using (true);

create table public.bench_table_087 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_087_owner_idx on public.bench_table_087 (owner_id);
create index bench_table_087_status_idx on public.bench_table_087 (status, created_at);
alter table public.bench_table_087 enable row level security;
create policy bench_table_087_read on public.bench_table_087 for select using (true);

create table public.bench_table_088 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_088_owner_idx on public.bench_table_088 (owner_id);
create index bench_table_088_status_idx on public.bench_table_088 (status, created_at);
alter table public.bench_table_088 enable row level security;
create policy bench_table_088_read on public.bench_table_088 for select using (true);

create table public.bench_table_089 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_089_owner_idx on public.bench_table_089 (owner_id);
create index bench_table_089_status_idx on public.bench_table_089 (status, created_at);
alter table public.bench_table_089 enable row level security;
create policy bench_table_089_read on public.bench_table_089 for select using (true);

create table public.bench_table_090 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_090_owner_idx on public.bench_table_090 (owner_id);
create index bench_table_090_status_idx on public.bench_table_090 (status, created_at);
alter table public.bench_table_090 enable row level security;
create policy bench_table_090_read on public.bench_table_090 for select using (true);

create view public.bench_table_090_summary as
  select status, count(*) as total from public.bench_table_090 group by status;

create function public.bench_table_090_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_090 $$;

create table public.bench_table_091 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_091_owner_idx on public.bench_table_091 (owner_id);
create index bench_table_091_status_idx on public.bench_table_091 (status, created_at);
alter table public.bench_table_091 enable row level security;
create policy bench_table_091_read on public.bench_table_091 for select using (true);

create table public.bench_table_092 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_092_owner_idx on public.bench_table_092 (owner_id);
create index bench_table_092_status_idx on public.bench_table_092 (status, created_at);
alter table public.bench_table_092 enable row level security;
create policy bench_table_092_read on public.bench_table_092 for select using (true);

create table public.bench_table_093 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_093_owner_idx on public.bench_table_093 (owner_id);
create index bench_table_093_status_idx on public.bench_table_093 (status, created_at);
alter table public.bench_table_093 enable row level security;
create policy bench_table_093_read on public.bench_table_093 for select using (true);

create table public.bench_table_094 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_094_owner_idx on public.bench_table_094 (owner_id);
create index bench_table_094_status_idx on public.bench_table_094 (status, created_at);
alter table public.bench_table_094 enable row level security;
create policy bench_table_094_read on public.bench_table_094 for select using (true);

create table public.bench_table_095 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_095_owner_idx on public.bench_table_095 (owner_id);
create index bench_table_095_status_idx on public.bench_table_095 (status, created_at);
alter table public.bench_table_095 enable row level security;
create policy bench_table_095_read on public.bench_table_095 for select using (true);

create view public.bench_table_095_summary as
  select status, count(*) as total from public.bench_table_095 group by status;

create table public.bench_table_096 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_096_owner_idx on public.bench_table_096 (owner_id);
create index bench_table_096_status_idx on public.bench_table_096 (status, created_at);
alter table public.bench_table_096 enable row level security;
create policy bench_table_096_read on public.bench_table_096 for select using (true);

create table public.bench_table_097 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_097_owner_idx on public.bench_table_097 (owner_id);
create index bench_table_097_status_idx on public.bench_table_097 (status, created_at);
alter table public.bench_table_097 enable row level security;
create policy bench_table_097_read on public.bench_table_097 for select using (true);

create table public.bench_table_098 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_098_owner_idx on public.bench_table_098 (owner_id);
create index bench_table_098_status_idx on public.bench_table_098 (status, created_at);
alter table public.bench_table_098 enable row level security;
create policy bench_table_098_read on public.bench_table_098 for select using (true);

create table public.bench_table_099 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_099_owner_idx on public.bench_table_099 (owner_id);
create index bench_table_099_status_idx on public.bench_table_099 (status, created_at);
alter table public.bench_table_099 enable row level security;
create policy bench_table_099_read on public.bench_table_099 for select using (true);

create table public.bench_table_100 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_100_owner_idx on public.bench_table_100 (owner_id);
create index bench_table_100_status_idx on public.bench_table_100 (status, created_at);
alter table public.bench_table_100 enable row level security;
create policy bench_table_100_read on public.bench_table_100 for select using (true);

create view public.bench_table_100_summary as
  select status, count(*) as total from public.bench_table_100 group by status;

create function public.bench_table_100_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_100 $$;

create table public.bench_table_101 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_101_owner_idx on public.bench_table_101 (owner_id);
create index bench_table_101_status_idx on public.bench_table_101 (status, created_at);
alter table public.bench_table_101 enable row level security;
create policy bench_table_101_read on public.bench_table_101 for select using (true);

create table public.bench_table_102 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_102_owner_idx on public.bench_table_102 (owner_id);
create index bench_table_102_status_idx on public.bench_table_102 (status, created_at);
alter table public.bench_table_102 enable row level security;
create policy bench_table_102_read on public.bench_table_102 for select using (true);

create table public.bench_table_103 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_103_owner_idx on public.bench_table_103 (owner_id);
create index bench_table_103_status_idx on public.bench_table_103 (status, created_at);
alter table public.bench_table_103 enable row level security;
create policy bench_table_103_read on public.bench_table_103 for select using (true);

create table public.bench_table_104 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_104_owner_idx on public.bench_table_104 (owner_id);
create index bench_table_104_status_idx on public.bench_table_104 (status, created_at);
alter table public.bench_table_104 enable row level security;
create policy bench_table_104_read on public.bench_table_104 for select using (true);

create table public.bench_table_105 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_105_owner_idx on public.bench_table_105 (owner_id);
create index bench_table_105_status_idx on public.bench_table_105 (status, created_at);
alter table public.bench_table_105 enable row level security;
create policy bench_table_105_read on public.bench_table_105 for select using (true);

create view public.bench_table_105_summary as
  select status, count(*) as total from public.bench_table_105 group by status;

create table public.bench_table_106 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_106_owner_idx on public.bench_table_106 (owner_id);
create index bench_table_106_status_idx on public.bench_table_106 (status, created_at);
alter table public.bench_table_106 enable row level security;
create policy bench_table_106_read on public.bench_table_106 for select using (true);

create table public.bench_table_107 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_107_owner_idx on public.bench_table_107 (owner_id);
create index bench_table_107_status_idx on public.bench_table_107 (status, created_at);
alter table public.bench_table_107 enable row level security;
create policy bench_table_107_read on public.bench_table_107 for select using (true);

create table public.bench_table_108 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_108_owner_idx on public.bench_table_108 (owner_id);
create index bench_table_108_status_idx on public.bench_table_108 (status, created_at);
alter table public.bench_table_108 enable row level security;
create policy bench_table_108_read on public.bench_table_108 for select using (true);

create table public.bench_table_109 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_109_owner_idx on public.bench_table_109 (owner_id);
create index bench_table_109_status_idx on public.bench_table_109 (status, created_at);
alter table public.bench_table_109 enable row level security;
create policy bench_table_109_read on public.bench_table_109 for select using (true);

create table public.bench_table_110 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_110_owner_idx on public.bench_table_110 (owner_id);
create index bench_table_110_status_idx on public.bench_table_110 (status, created_at);
alter table public.bench_table_110 enable row level security;
create policy bench_table_110_read on public.bench_table_110 for select using (true);

create view public.bench_table_110_summary as
  select status, count(*) as total from public.bench_table_110 group by status;

create function public.bench_table_110_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_110 $$;

create table public.bench_table_111 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_111_owner_idx on public.bench_table_111 (owner_id);
create index bench_table_111_status_idx on public.bench_table_111 (status, created_at);
alter table public.bench_table_111 enable row level security;
create policy bench_table_111_read on public.bench_table_111 for select using (true);

create table public.bench_table_112 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_112_owner_idx on public.bench_table_112 (owner_id);
create index bench_table_112_status_idx on public.bench_table_112 (status, created_at);
alter table public.bench_table_112 enable row level security;
create policy bench_table_112_read on public.bench_table_112 for select using (true);

create table public.bench_table_113 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_113_owner_idx on public.bench_table_113 (owner_id);
create index bench_table_113_status_idx on public.bench_table_113 (status, created_at);
alter table public.bench_table_113 enable row level security;
create policy bench_table_113_read on public.bench_table_113 for select using (true);

create table public.bench_table_114 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_114_owner_idx on public.bench_table_114 (owner_id);
create index bench_table_114_status_idx on public.bench_table_114 (status, created_at);
alter table public.bench_table_114 enable row level security;
create policy bench_table_114_read on public.bench_table_114 for select using (true);

create table public.bench_table_115 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_115_owner_idx on public.bench_table_115 (owner_id);
create index bench_table_115_status_idx on public.bench_table_115 (status, created_at);
alter table public.bench_table_115 enable row level security;
create policy bench_table_115_read on public.bench_table_115 for select using (true);

create view public.bench_table_115_summary as
  select status, count(*) as total from public.bench_table_115 group by status;

create table public.bench_table_116 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_116_owner_idx on public.bench_table_116 (owner_id);
create index bench_table_116_status_idx on public.bench_table_116 (status, created_at);
alter table public.bench_table_116 enable row level security;
create policy bench_table_116_read on public.bench_table_116 for select using (true);

create table public.bench_table_117 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_117_owner_idx on public.bench_table_117 (owner_id);
create index bench_table_117_status_idx on public.bench_table_117 (status, created_at);
alter table public.bench_table_117 enable row level security;
create policy bench_table_117_read on public.bench_table_117 for select using (true);

create table public.bench_table_118 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_118_owner_idx on public.bench_table_118 (owner_id);
create index bench_table_118_status_idx on public.bench_table_118 (status, created_at);
alter table public.bench_table_118 enable row level security;
create policy bench_table_118_read on public.bench_table_118 for select using (true);

create table public.bench_table_119 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_119_owner_idx on public.bench_table_119 (owner_id);
create index bench_table_119_status_idx on public.bench_table_119 (status, created_at);
alter table public.bench_table_119 enable row level security;
create policy bench_table_119_read on public.bench_table_119 for select using (true);

create table public.bench_table_120 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_120_owner_idx on public.bench_table_120 (owner_id);
create index bench_table_120_status_idx on public.bench_table_120 (status, created_at);
alter table public.bench_table_120 enable row level security;
create policy bench_table_120_read on public.bench_table_120 for select using (true);

create view public.bench_table_120_summary as
  select status, count(*) as total from public.bench_table_120 group by status;

create function public.bench_table_120_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_120 $$;

create table public.bench_table_121 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_121_owner_idx on public.bench_table_121 (owner_id);
create index bench_table_121_status_idx on public.bench_table_121 (status, created_at);
alter table public.bench_table_121 enable row level security;
create policy bench_table_121_read on public.bench_table_121 for select using (true);

create table public.bench_table_122 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_122_owner_idx on public.bench_table_122 (owner_id);
create index bench_table_122_status_idx on public.bench_table_122 (status, created_at);
alter table public.bench_table_122 enable row level security;
create policy bench_table_122_read on public.bench_table_122 for select using (true);

create table public.bench_table_123 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_123_owner_idx on public.bench_table_123 (owner_id);
create index bench_table_123_status_idx on public.bench_table_123 (status, created_at);
alter table public.bench_table_123 enable row level security;
create policy bench_table_123_read on public.bench_table_123 for select using (true);

create table public.bench_table_124 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_124_owner_idx on public.bench_table_124 (owner_id);
create index bench_table_124_status_idx on public.bench_table_124 (status, created_at);
alter table public.bench_table_124 enable row level security;
create policy bench_table_124_read on public.bench_table_124 for select using (true);

create table public.bench_table_125 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_125_owner_idx on public.bench_table_125 (owner_id);
create index bench_table_125_status_idx on public.bench_table_125 (status, created_at);
alter table public.bench_table_125 enable row level security;
create policy bench_table_125_read on public.bench_table_125 for select using (true);

create view public.bench_table_125_summary as
  select status, count(*) as total from public.bench_table_125 group by status;

create table public.bench_table_126 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_126_owner_idx on public.bench_table_126 (owner_id);
create index bench_table_126_status_idx on public.bench_table_126 (status, created_at);
alter table public.bench_table_126 enable row level security;
create policy bench_table_126_read on public.bench_table_126 for select using (true);

create table public.bench_table_127 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_127_owner_idx on public.bench_table_127 (owner_id);
create index bench_table_127_status_idx on public.bench_table_127 (status, created_at);
alter table public.bench_table_127 enable row level security;
create policy bench_table_127_read on public.bench_table_127 for select using (true);

create table public.bench_table_128 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_128_owner_idx on public.bench_table_128 (owner_id);
create index bench_table_128_status_idx on public.bench_table_128 (status, created_at);
alter table public.bench_table_128 enable row level security;
create policy bench_table_128_read on public.bench_table_128 for select using (true);

create table public.bench_table_129 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_129_owner_idx on public.bench_table_129 (owner_id);
create index bench_table_129_status_idx on public.bench_table_129 (status, created_at);
alter table public.bench_table_129 enable row level security;
create policy bench_table_129_read on public.bench_table_129 for select using (true);

create table public.bench_table_130 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_130_owner_idx on public.bench_table_130 (owner_id);
create index bench_table_130_status_idx on public.bench_table_130 (status, created_at);
alter table public.bench_table_130 enable row level security;
create policy bench_table_130_read on public.bench_table_130 for select using (true);

create view public.bench_table_130_summary as
  select status, count(*) as total from public.bench_table_130 group by status;

create function public.bench_table_130_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_130 $$;

create table public.bench_table_131 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_131_owner_idx on public.bench_table_131 (owner_id);
create index bench_table_131_status_idx on public.bench_table_131 (status, created_at);
alter table public.bench_table_131 enable row level security;
create policy bench_table_131_read on public.bench_table_131 for select using (true);

create table public.bench_table_132 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_132_owner_idx on public.bench_table_132 (owner_id);
create index bench_table_132_status_idx on public.bench_table_132 (status, created_at);
alter table public.bench_table_132 enable row level security;
create policy bench_table_132_read on public.bench_table_132 for select using (true);

create table public.bench_table_133 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_133_owner_idx on public.bench_table_133 (owner_id);
create index bench_table_133_status_idx on public.bench_table_133 (status, created_at);
alter table public.bench_table_133 enable row level security;
create policy bench_table_133_read on public.bench_table_133 for select using (true);

create table public.bench_table_134 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_134_owner_idx on public.bench_table_134 (owner_id);
create index bench_table_134_status_idx on public.bench_table_134 (status, created_at);
alter table public.bench_table_134 enable row level security;
create policy bench_table_134_read on public.bench_table_134 for select using (true);

create table public.bench_table_135 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_135_owner_idx on public.bench_table_135 (owner_id);
create index bench_table_135_status_idx on public.bench_table_135 (status, created_at);
alter table public.bench_table_135 enable row level security;
create policy bench_table_135_read on public.bench_table_135 for select using (true);

create view public.bench_table_135_summary as
  select status, count(*) as total from public.bench_table_135 group by status;

create table public.bench_table_136 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_136_owner_idx on public.bench_table_136 (owner_id);
create index bench_table_136_status_idx on public.bench_table_136 (status, created_at);
alter table public.bench_table_136 enable row level security;
create policy bench_table_136_read on public.bench_table_136 for select using (true);

create table public.bench_table_137 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_137_owner_idx on public.bench_table_137 (owner_id);
create index bench_table_137_status_idx on public.bench_table_137 (status, created_at);
alter table public.bench_table_137 enable row level security;
create policy bench_table_137_read on public.bench_table_137 for select using (true);

create table public.bench_table_138 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_138_owner_idx on public.bench_table_138 (owner_id);
create index bench_table_138_status_idx on public.bench_table_138 (status, created_at);
alter table public.bench_table_138 enable row level security;
create policy bench_table_138_read on public.bench_table_138 for select using (true);

create table public.bench_table_139 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_139_owner_idx on public.bench_table_139 (owner_id);
create index bench_table_139_status_idx on public.bench_table_139 (status, created_at);
alter table public.bench_table_139 enable row level security;
create policy bench_table_139_read on public.bench_table_139 for select using (true);

create table public.bench_table_140 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_140_owner_idx on public.bench_table_140 (owner_id);
create index bench_table_140_status_idx on public.bench_table_140 (status, created_at);
alter table public.bench_table_140 enable row level security;
create policy bench_table_140_read on public.bench_table_140 for select using (true);

create view public.bench_table_140_summary as
  select status, count(*) as total from public.bench_table_140 group by status;

create function public.bench_table_140_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_140 $$;

create table public.bench_table_141 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_141_owner_idx on public.bench_table_141 (owner_id);
create index bench_table_141_status_idx on public.bench_table_141 (status, created_at);
alter table public.bench_table_141 enable row level security;
create policy bench_table_141_read on public.bench_table_141 for select using (true);

create table public.bench_table_142 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_142_owner_idx on public.bench_table_142 (owner_id);
create index bench_table_142_status_idx on public.bench_table_142 (status, created_at);
alter table public.bench_table_142 enable row level security;
create policy bench_table_142_read on public.bench_table_142 for select using (true);

create table public.bench_table_143 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_143_owner_idx on public.bench_table_143 (owner_id);
create index bench_table_143_status_idx on public.bench_table_143 (status, created_at);
alter table public.bench_table_143 enable row level security;
create policy bench_table_143_read on public.bench_table_143 for select using (true);

create table public.bench_table_144 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_144_owner_idx on public.bench_table_144 (owner_id);
create index bench_table_144_status_idx on public.bench_table_144 (status, created_at);
alter table public.bench_table_144 enable row level security;
create policy bench_table_144_read on public.bench_table_144 for select using (true);

create table public.bench_table_145 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_145_owner_idx on public.bench_table_145 (owner_id);
create index bench_table_145_status_idx on public.bench_table_145 (status, created_at);
alter table public.bench_table_145 enable row level security;
create policy bench_table_145_read on public.bench_table_145 for select using (true);

create view public.bench_table_145_summary as
  select status, count(*) as total from public.bench_table_145 group by status;

create table public.bench_table_146 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_146_owner_idx on public.bench_table_146 (owner_id);
create index bench_table_146_status_idx on public.bench_table_146 (status, created_at);
alter table public.bench_table_146 enable row level security;
create policy bench_table_146_read on public.bench_table_146 for select using (true);

create table public.bench_table_147 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_147_owner_idx on public.bench_table_147 (owner_id);
create index bench_table_147_status_idx on public.bench_table_147 (status, created_at);
alter table public.bench_table_147 enable row level security;
create policy bench_table_147_read on public.bench_table_147 for select using (true);

create table public.bench_table_148 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_148_owner_idx on public.bench_table_148 (owner_id);
create index bench_table_148_status_idx on public.bench_table_148 (status, created_at);
alter table public.bench_table_148 enable row level security;
create policy bench_table_148_read on public.bench_table_148 for select using (true);

create table public.bench_table_149 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_149_owner_idx on public.bench_table_149 (owner_id);
create index bench_table_149_status_idx on public.bench_table_149 (status, created_at);
alter table public.bench_table_149 enable row level security;
create policy bench_table_149_read on public.bench_table_149 for select using (true);

create table public.bench_table_150 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_150_owner_idx on public.bench_table_150 (owner_id);
create index bench_table_150_status_idx on public.bench_table_150 (status, created_at);
alter table public.bench_table_150 enable row level security;
create policy bench_table_150_read on public.bench_table_150 for select using (true);

create view public.bench_table_150_summary as
  select status, count(*) as total from public.bench_table_150 group by status;

create function public.bench_table_150_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_150 $$;

create table public.bench_table_151 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_151_owner_idx on public.bench_table_151 (owner_id);
create index bench_table_151_status_idx on public.bench_table_151 (status, created_at);
alter table public.bench_table_151 enable row level security;
create policy bench_table_151_read on public.bench_table_151 for select using (true);

create table public.bench_table_152 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_152_owner_idx on public.bench_table_152 (owner_id);
create index bench_table_152_status_idx on public.bench_table_152 (status, created_at);
alter table public.bench_table_152 enable row level security;
create policy bench_table_152_read on public.bench_table_152 for select using (true);

create table public.bench_table_153 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_153_owner_idx on public.bench_table_153 (owner_id);
create index bench_table_153_status_idx on public.bench_table_153 (status, created_at);
alter table public.bench_table_153 enable row level security;
create policy bench_table_153_read on public.bench_table_153 for select using (true);

create table public.bench_table_154 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_154_owner_idx on public.bench_table_154 (owner_id);
create index bench_table_154_status_idx on public.bench_table_154 (status, created_at);
alter table public.bench_table_154 enable row level security;
create policy bench_table_154_read on public.bench_table_154 for select using (true);

create table public.bench_table_155 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_155_owner_idx on public.bench_table_155 (owner_id);
create index bench_table_155_status_idx on public.bench_table_155 (status, created_at);
alter table public.bench_table_155 enable row level security;
create policy bench_table_155_read on public.bench_table_155 for select using (true);

create view public.bench_table_155_summary as
  select status, count(*) as total from public.bench_table_155 group by status;

create table public.bench_table_156 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_156_owner_idx on public.bench_table_156 (owner_id);
create index bench_table_156_status_idx on public.bench_table_156 (status, created_at);
alter table public.bench_table_156 enable row level security;
create policy bench_table_156_read on public.bench_table_156 for select using (true);

create table public.bench_table_157 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_157_owner_idx on public.bench_table_157 (owner_id);
create index bench_table_157_status_idx on public.bench_table_157 (status, created_at);
alter table public.bench_table_157 enable row level security;
create policy bench_table_157_read on public.bench_table_157 for select using (true);

create table public.bench_table_158 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_158_owner_idx on public.bench_table_158 (owner_id);
create index bench_table_158_status_idx on public.bench_table_158 (status, created_at);
alter table public.bench_table_158 enable row level security;
create policy bench_table_158_read on public.bench_table_158 for select using (true);

create table public.bench_table_159 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_159_owner_idx on public.bench_table_159 (owner_id);
create index bench_table_159_status_idx on public.bench_table_159 (status, created_at);
alter table public.bench_table_159 enable row level security;
create policy bench_table_159_read on public.bench_table_159 for select using (true);

create table public.bench_table_160 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_160_owner_idx on public.bench_table_160 (owner_id);
create index bench_table_160_status_idx on public.bench_table_160 (status, created_at);
alter table public.bench_table_160 enable row level security;
create policy bench_table_160_read on public.bench_table_160 for select using (true);

create view public.bench_table_160_summary as
  select status, count(*) as total from public.bench_table_160 group by status;

create function public.bench_table_160_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_160 $$;

create table public.bench_table_161 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_161_owner_idx on public.bench_table_161 (owner_id);
create index bench_table_161_status_idx on public.bench_table_161 (status, created_at);
alter table public.bench_table_161 enable row level security;
create policy bench_table_161_read on public.bench_table_161 for select using (true);

create table public.bench_table_162 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_162_owner_idx on public.bench_table_162 (owner_id);
create index bench_table_162_status_idx on public.bench_table_162 (status, created_at);
alter table public.bench_table_162 enable row level security;
create policy bench_table_162_read on public.bench_table_162 for select using (true);

create table public.bench_table_163 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_163_owner_idx on public.bench_table_163 (owner_id);
create index bench_table_163_status_idx on public.bench_table_163 (status, created_at);
alter table public.bench_table_163 enable row level security;
create policy bench_table_163_read on public.bench_table_163 for select using (true);

create table public.bench_table_164 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_164_owner_idx on public.bench_table_164 (owner_id);
create index bench_table_164_status_idx on public.bench_table_164 (status, created_at);
alter table public.bench_table_164 enable row level security;
create policy bench_table_164_read on public.bench_table_164 for select using (true);

create table public.bench_table_165 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_165_owner_idx on public.bench_table_165 (owner_id);
create index bench_table_165_status_idx on public.bench_table_165 (status, created_at);
alter table public.bench_table_165 enable row level security;
create policy bench_table_165_read on public.bench_table_165 for select using (true);

create view public.bench_table_165_summary as
  select status, count(*) as total from public.bench_table_165 group by status;

create table public.bench_table_166 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_166_owner_idx on public.bench_table_166 (owner_id);
create index bench_table_166_status_idx on public.bench_table_166 (status, created_at);
alter table public.bench_table_166 enable row level security;
create policy bench_table_166_read on public.bench_table_166 for select using (true);

create table public.bench_table_167 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_167_owner_idx on public.bench_table_167 (owner_id);
create index bench_table_167_status_idx on public.bench_table_167 (status, created_at);
alter table public.bench_table_167 enable row level security;
create policy bench_table_167_read on public.bench_table_167 for select using (true);

create table public.bench_table_168 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_168_owner_idx on public.bench_table_168 (owner_id);
create index bench_table_168_status_idx on public.bench_table_168 (status, created_at);
alter table public.bench_table_168 enable row level security;
create policy bench_table_168_read on public.bench_table_168 for select using (true);

create table public.bench_table_169 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_169_owner_idx on public.bench_table_169 (owner_id);
create index bench_table_169_status_idx on public.bench_table_169 (status, created_at);
alter table public.bench_table_169 enable row level security;
create policy bench_table_169_read on public.bench_table_169 for select using (true);

create table public.bench_table_170 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_170_owner_idx on public.bench_table_170 (owner_id);
create index bench_table_170_status_idx on public.bench_table_170 (status, created_at);
alter table public.bench_table_170 enable row level security;
create policy bench_table_170_read on public.bench_table_170 for select using (true);

create view public.bench_table_170_summary as
  select status, count(*) as total from public.bench_table_170 group by status;

create function public.bench_table_170_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_170 $$;

create table public.bench_table_171 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_171_owner_idx on public.bench_table_171 (owner_id);
create index bench_table_171_status_idx on public.bench_table_171 (status, created_at);
alter table public.bench_table_171 enable row level security;
create policy bench_table_171_read on public.bench_table_171 for select using (true);

create table public.bench_table_172 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_172_owner_idx on public.bench_table_172 (owner_id);
create index bench_table_172_status_idx on public.bench_table_172 (status, created_at);
alter table public.bench_table_172 enable row level security;
create policy bench_table_172_read on public.bench_table_172 for select using (true);

create table public.bench_table_173 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_173_owner_idx on public.bench_table_173 (owner_id);
create index bench_table_173_status_idx on public.bench_table_173 (status, created_at);
alter table public.bench_table_173 enable row level security;
create policy bench_table_173_read on public.bench_table_173 for select using (true);

create table public.bench_table_174 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_174_owner_idx on public.bench_table_174 (owner_id);
create index bench_table_174_status_idx on public.bench_table_174 (status, created_at);
alter table public.bench_table_174 enable row level security;
create policy bench_table_174_read on public.bench_table_174 for select using (true);

create table public.bench_table_175 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_175_owner_idx on public.bench_table_175 (owner_id);
create index bench_table_175_status_idx on public.bench_table_175 (status, created_at);
alter table public.bench_table_175 enable row level security;
create policy bench_table_175_read on public.bench_table_175 for select using (true);

create view public.bench_table_175_summary as
  select status, count(*) as total from public.bench_table_175 group by status;

create table public.bench_table_176 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_176_owner_idx on public.bench_table_176 (owner_id);
create index bench_table_176_status_idx on public.bench_table_176 (status, created_at);
alter table public.bench_table_176 enable row level security;
create policy bench_table_176_read on public.bench_table_176 for select using (true);

create table public.bench_table_177 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_177_owner_idx on public.bench_table_177 (owner_id);
create index bench_table_177_status_idx on public.bench_table_177 (status, created_at);
alter table public.bench_table_177 enable row level security;
create policy bench_table_177_read on public.bench_table_177 for select using (true);

create table public.bench_table_178 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_178_owner_idx on public.bench_table_178 (owner_id);
create index bench_table_178_status_idx on public.bench_table_178 (status, created_at);
alter table public.bench_table_178 enable row level security;
create policy bench_table_178_read on public.bench_table_178 for select using (true);

create table public.bench_table_179 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_179_owner_idx on public.bench_table_179 (owner_id);
create index bench_table_179_status_idx on public.bench_table_179 (status, created_at);
alter table public.bench_table_179 enable row level security;
create policy bench_table_179_read on public.bench_table_179 for select using (true);

create table public.bench_table_180 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_180_owner_idx on public.bench_table_180 (owner_id);
create index bench_table_180_status_idx on public.bench_table_180 (status, created_at);
alter table public.bench_table_180 enable row level security;
create policy bench_table_180_read on public.bench_table_180 for select using (true);

create view public.bench_table_180_summary as
  select status, count(*) as total from public.bench_table_180 group by status;

create function public.bench_table_180_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_180 $$;

create table public.bench_table_181 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_181_owner_idx on public.bench_table_181 (owner_id);
create index bench_table_181_status_idx on public.bench_table_181 (status, created_at);
alter table public.bench_table_181 enable row level security;
create policy bench_table_181_read on public.bench_table_181 for select using (true);

create table public.bench_table_182 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_182_owner_idx on public.bench_table_182 (owner_id);
create index bench_table_182_status_idx on public.bench_table_182 (status, created_at);
alter table public.bench_table_182 enable row level security;
create policy bench_table_182_read on public.bench_table_182 for select using (true);

create table public.bench_table_183 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_183_owner_idx on public.bench_table_183 (owner_id);
create index bench_table_183_status_idx on public.bench_table_183 (status, created_at);
alter table public.bench_table_183 enable row level security;
create policy bench_table_183_read on public.bench_table_183 for select using (true);

create table public.bench_table_184 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_184_owner_idx on public.bench_table_184 (owner_id);
create index bench_table_184_status_idx on public.bench_table_184 (status, created_at);
alter table public.bench_table_184 enable row level security;
create policy bench_table_184_read on public.bench_table_184 for select using (true);

create table public.bench_table_185 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_185_owner_idx on public.bench_table_185 (owner_id);
create index bench_table_185_status_idx on public.bench_table_185 (status, created_at);
alter table public.bench_table_185 enable row level security;
create policy bench_table_185_read on public.bench_table_185 for select using (true);

create view public.bench_table_185_summary as
  select status, count(*) as total from public.bench_table_185 group by status;

create table public.bench_table_186 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_186_owner_idx on public.bench_table_186 (owner_id);
create index bench_table_186_status_idx on public.bench_table_186 (status, created_at);
alter table public.bench_table_186 enable row level security;
create policy bench_table_186_read on public.bench_table_186 for select using (true);

create table public.bench_table_187 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_187_owner_idx on public.bench_table_187 (owner_id);
create index bench_table_187_status_idx on public.bench_table_187 (status, created_at);
alter table public.bench_table_187 enable row level security;
create policy bench_table_187_read on public.bench_table_187 for select using (true);

create table public.bench_table_188 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_188_owner_idx on public.bench_table_188 (owner_id);
create index bench_table_188_status_idx on public.bench_table_188 (status, created_at);
alter table public.bench_table_188 enable row level security;
create policy bench_table_188_read on public.bench_table_188 for select using (true);

create table public.bench_table_189 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_189_owner_idx on public.bench_table_189 (owner_id);
create index bench_table_189_status_idx on public.bench_table_189 (status, created_at);
alter table public.bench_table_189 enable row level security;
create policy bench_table_189_read on public.bench_table_189 for select using (true);

create table public.bench_table_190 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_190_owner_idx on public.bench_table_190 (owner_id);
create index bench_table_190_status_idx on public.bench_table_190 (status, created_at);
alter table public.bench_table_190 enable row level security;
create policy bench_table_190_read on public.bench_table_190 for select using (true);

create view public.bench_table_190_summary as
  select status, count(*) as total from public.bench_table_190 group by status;

create function public.bench_table_190_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_190 $$;

create table public.bench_table_191 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_191_owner_idx on public.bench_table_191 (owner_id);
create index bench_table_191_status_idx on public.bench_table_191 (status, created_at);
alter table public.bench_table_191 enable row level security;
create policy bench_table_191_read on public.bench_table_191 for select using (true);

create table public.bench_table_192 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_192_owner_idx on public.bench_table_192 (owner_id);
create index bench_table_192_status_idx on public.bench_table_192 (status, created_at);
alter table public.bench_table_192 enable row level security;
create policy bench_table_192_read on public.bench_table_192 for select using (true);

create table public.bench_table_193 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_193_owner_idx on public.bench_table_193 (owner_id);
create index bench_table_193_status_idx on public.bench_table_193 (status, created_at);
alter table public.bench_table_193 enable row level security;
create policy bench_table_193_read on public.bench_table_193 for select using (true);

create table public.bench_table_194 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_194_owner_idx on public.bench_table_194 (owner_id);
create index bench_table_194_status_idx on public.bench_table_194 (status, created_at);
alter table public.bench_table_194 enable row level security;
create policy bench_table_194_read on public.bench_table_194 for select using (true);

create table public.bench_table_195 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_195_owner_idx on public.bench_table_195 (owner_id);
create index bench_table_195_status_idx on public.bench_table_195 (status, created_at);
alter table public.bench_table_195 enable row level security;
create policy bench_table_195_read on public.bench_table_195 for select using (true);

create view public.bench_table_195_summary as
  select status, count(*) as total from public.bench_table_195 group by status;

create table public.bench_table_196 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_196_owner_idx on public.bench_table_196 (owner_id);
create index bench_table_196_status_idx on public.bench_table_196 (status, created_at);
alter table public.bench_table_196 enable row level security;
create policy bench_table_196_read on public.bench_table_196 for select using (true);

create table public.bench_table_197 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_197_owner_idx on public.bench_table_197 (owner_id);
create index bench_table_197_status_idx on public.bench_table_197 (status, created_at);
alter table public.bench_table_197 enable row level security;
create policy bench_table_197_read on public.bench_table_197 for select using (true);

create table public.bench_table_198 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_198_owner_idx on public.bench_table_198 (owner_id);
create index bench_table_198_status_idx on public.bench_table_198 (status, created_at);
alter table public.bench_table_198 enable row level security;
create policy bench_table_198_read on public.bench_table_198 for select using (true);

create table public.bench_table_199 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_199_owner_idx on public.bench_table_199 (owner_id);
create index bench_table_199_status_idx on public.bench_table_199 (status, created_at);
alter table public.bench_table_199 enable row level security;
create policy bench_table_199_read on public.bench_table_199 for select using (true);

create table public.bench_table_200 (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index bench_table_200_owner_idx on public.bench_table_200 (owner_id);
create index bench_table_200_status_idx on public.bench_table_200 (status, created_at);
alter table public.bench_table_200 enable row level security;
create policy bench_table_200_read on public.bench_table_200 for select using (true);

create view public.bench_table_200_summary as
  select status, count(*) as total from public.bench_table_200 group by status;

create function public.bench_table_200_count() returns bigint
  language sql stable as $$ select count(*) from public.bench_table_200 $$;
