# db-role-connections

This command shows the number of active connections for each database roles to see which specific role might be consuming more connections than expected.

This is a Supabase specific command. You can see this breakdown on the dashboard as well:
https://app.supabase.com/project/_/database/roles

The maximum number of active connections depends [on your instance size](https://supabase.com/docs/guides/platform/compute-add-ons).

```


            ROLE NAME         │ ACTIVE CONNCTION
  ────────────────────────────┼───────────────────
    authenticator             │                5
    postgres                  │                5
    supabase_admin            │                1
    pgbouncer                 │                1
    anon                      │                0
    authenticated             │                0
    service_role              │                0
    dashboard_user            │                0
    supabase_auth_admin       │                0
    supabase_storage_admin    │                0
    supabase_functions_admin  │                0
    pgsodium_keyholder        │                0
    pg_read_all_data          │                0
    pg_write_all_data         │                0
    pg_monitor                │                0

Active connections 12/90

```
