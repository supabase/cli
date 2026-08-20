-- Todos schema for the TanStack Start example app.
-- Apply with: psql "<db-url>" -f supabase/schema.sql

create table public.todos (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title text not null,
  done boolean not null default false,
  inserted_at timestamptz not null default now()
);

alter table public.todos enable row level security;

create policy "owners can select their todos" on public.todos
  for select using ((select auth.uid()) = user_id);
create policy "owners can insert their todos" on public.todos
  for insert with check ((select auth.uid()) = user_id);
create policy "owners can update their todos" on public.todos
  for update using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "owners can delete their todos" on public.todos
  for delete using ((select auth.uid()) = user_id);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on table public.todos to authenticated;
grant usage, select on all sequences in schema public to authenticated;

notify pgrst, 'reload schema';
