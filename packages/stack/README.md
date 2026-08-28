# `@supabase/stack`

The local Supabase stack runtime. Its public API is being rebuilt as a
greenfield Effect-native managed runtime; implementation modules are private
to the package.

The supported entrypoints are:

- `@supabase/stack` — Promise facade
- `@supabase/stack/effect` — Effect-native API
- `@supabase/stack/testing` — test helpers
