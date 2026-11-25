---
id: status
kind: command
category: general
title: status
symbol: supabase status
summary: Show the local Supabase stack status
usage: supabase status [flags]
stability: stable
deprecated: false
inherits_flags: global
parameters:
  - name: --override-name
    location: flag
    type: strings
    description: Rename an exported variable, as key=NAME pairs or a comma-separated list.
    variadic: true
examples:
  - id: basic-usage
    title: Basic usage
    lang: sh
    code: supabase status
    response: |
      supabase local development setup is running.

               API URL: http://127.0.0.1:54321
           GraphQL URL: http://127.0.0.1:54321/graphql/v1
                DB URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres
            Studio URL: http://127.0.0.1:54323
           Mailpit URL: http://127.0.0.1:54324
            JWT secret: super-secret-jwt-token-with-at-least-32-characters-long
              anon key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0
      service_role key: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU
  - id: output-env
    title: Format status as environment variables
    lang: sh
    code: supabase status -o env
    response: |
      ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
      API_URL="http://127.0.0.1:54321"
      DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
      GRAPHQL_URL="http://127.0.0.1:54321/graphql/v1"
      JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long"
      SERVICE_ROLE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
      STUDIO_URL="http://127.0.0.1:54323"
  - id: output-custom-name
    title: Customize the names of exported variables
    lang: sh
    code: supabase status -o env --override-name auth.anon_key=SUPABASE_ANON_KEY --override-name auth.service_role_key=SUPABASE_SERVICE_KEY
    response: |
      Stopped services: [supabase_inbucket_cli supabase_rest_cli supabase_studio_cli]
      SUPABASE_ANON_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0"
      DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
      GRAPHQL_URL="http://127.0.0.1:54321/graphql/v1"
      JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long"
      SUPABASE_SERVICE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU"
---

Prints the URLs, keys, and database connection string of the running local stack. The stack must already be running, started with `supabase start` or `supabase db start`.

To export the connection parameters for [initializing supabase-js](https://supabase.com/docs/reference/javascript/initializing) locally, pass `-o env`. The output includes `JWT_SECRET`, `ANON_KEY`, and `SERVICE_ROLE_KEY`.
