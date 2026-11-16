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
