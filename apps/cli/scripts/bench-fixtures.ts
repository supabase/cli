/**
 * Regenerates the benchmark fixtures under `apps/cli/bench/fixtures/`. The output is deterministic and committed,
 * so a series of results keeps measuring the same work; changing it starts a new series. Run as
 * `bun apps/cli/scripts/bench-fixtures.ts`.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";

/** Tables in each schema fixture. */
export const SCHEMA_SIZES = { small: 10, medium: 50, large: 200 } as const;
/** Migrations in the `migrations` fixture. */
export const MIGRATION_COUNT = 20;
/** Rows inserted by the `migrations` fixture's seed. */
export const SEED_ROWS = 1000;

const table = (index: number) => `bench_table_${String(index).padStart(3, "0")}`;

/** One migration creating `count` related tables, indexes, policies, views and functions. */
export function schemaSql(count: number): string {
  const blocks: Array<string> = [];
  for (let index = 1; index <= count; index++) {
    const name = table(index);
    blocks.push(
      `create table public.${name} (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  name text not null,
  status text not null default 'active',
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index ${name}_owner_idx on public.${name} (owner_id);
create index ${name}_status_idx on public.${name} (status, created_at);
alter table public.${name} enable row level security;
create policy ${name}_read on public.${name} for select using (true);`,
    );
    if (index % 5 === 0) {
      blocks.push(
        `create view public.${name}_summary as
  select status, count(*) as total from public.${name} group by status;`,
      );
    }
    if (index % 10 === 0) {
      blocks.push(
        `create function public.${name}_count() returns bigint
  language sql stable as $$ select count(*) from public.${name} $$;`,
      );
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

/** Migration `index` of the `migrations` fixture; the first one owns the seeded table. */
export function migrationSql(index: number): string {
  if (index === 1) {
    return `create table public.bench_items (
  id bigint generated always as identity primary key,
  label text not null,
  amount numeric not null,
  created_at timestamptz not null default now()
);
create index bench_items_label_idx on public.bench_items (label);
`;
  }
  const name = table(index);
  return `create table public.${name} (
  id uuid primary key default gen_random_uuid(),
  item_id bigint references public.bench_items (id),
  note text not null default ''
);
create index ${name}_item_idx on public.${name} (item_id);
`;
}

/** Seed for the `migrations` fixture. */
export const seedSql = `insert into public.bench_items (label, amount)
select 'item-' || n, (n % 97) * 1.5 from generate_series(1, ${SEED_ROWS}) as n;
`;

const stamp = (index: number) => `2026010100${String(index).padStart(4, "0")}`;

/** The pgTAP fixture: one table and a test file over it. */
export const pgtapMigration = `create table public.bench_checks (
  id bigint generated always as identity primary key,
  label text not null
);
`;

export const pgtapTest = `begin;
select plan(4);
select has_table('public', 'bench_checks', 'bench_checks exists');
select has_column('public', 'bench_checks', 'label', 'label column exists');
select col_not_null('public', 'bench_checks', 'label', 'label is required');
select col_is_pk('public', 'bench_checks', 'id', 'id is the primary key');
select * from finish();
rollback;
`;

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "bench",
    "fixtures",
  );
  const write = Effect.fnUntraced(function* (relative: string, content: string) {
    const file = path.join(root, relative);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, content);
  });

  for (const [size, count] of Object.entries(SCHEMA_SIZES)) {
    yield* write(`schema-${size}/migrations/${stamp(1)}_bench_schema.sql`, schemaSql(count));
  }
  for (let index = 1; index <= MIGRATION_COUNT; index++) {
    yield* write(
      `migrations/migrations/${stamp(index)}_bench_${String(index).padStart(2, "0")}.sql`,
      migrationSql(index),
    );
  }
  yield* write("migrations/seed.sql", seedSql);
  yield* write(`pgtap/migrations/${stamp(1)}_bench_checks.sql`, pgtapMigration);
  yield* write("pgtap/tests/database/bench.test.sql", pgtapTest);
});

if (import.meta.main) {
  BunRuntime.runMain(main.pipe(Effect.provide(BunServices.layer)));
}
