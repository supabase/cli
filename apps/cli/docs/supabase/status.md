## supabase-status

Prints the URLs, keys, and database connection string of the running local stack. The stack must already be running, started with `supabase start` or `supabase db start`.

To export the connection parameters for [initializing supabase-js](https://supabase.com/docs/reference/javascript/initializing) locally, pass `-o env`. The output includes `JWT_SECRET`, `ANON_KEY`, and `SERVICE_ROLE_KEY`.
