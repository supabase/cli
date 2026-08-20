# TanStack Start + Supabase Todos

A minimal todo app built with [TanStack Start](https://tanstack.com/start) against a
local Supabase stack run by the native (dockerless) CLI runtime. Email/password auth
uses the local stack's email autoconfirm, so sign-up returns a live session with no
confirmation email round-trip. Todos are per-user, enforced with row level security.

## Run it

1. Start a local stack (from the repo root):

   ```sh
   bun apps/cli/src/next/main.ts start --mode native --stack app --detach \
     --exclude realtime --exclude storage --exclude imgproxy --exclude mailpit \
     --exclude pgmeta --exclude studio --exclude analytics --exclude vector \
     --exclude pooler
   ```

2. Apply the schema using the DB URL printed by `start` (or `status --stack app`):

   ```sh
   psql "<db-url>" -f supabase/schema.sql
   ```

3. Configure the app with the API URL and publishable key from the start output:

   ```sh
   cp .env.example .env   # then fill in the printed values
   ```

4. Install and run:

   ```sh
   bun install
   bun run dev
   ```

   The app is served at http://localhost:3000.

## What it demonstrates

- **Auth with email autoconfirm** — sign up lands you straight in a session
  (`GOTRUE_MAILER_AUTOCONFIRM` is on in the native stack), and sign-out/sign-in
  round-trips work against the local Auth service.
- **Row level security** — the `todos` policies scope every read and write to
  `auth.uid()`; anonymous requests are denied.
- **PostgREST data access** — all todo reads/writes go through
  `@supabase/supabase-js` to `<api-url>/rest/v1/todos`.
