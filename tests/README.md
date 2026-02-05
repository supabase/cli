## End-to-End tests from client lib to local stack

### Auth test

1. Run user signup tests

```bash
./tests/auth.sh
```

### PostgREST test

1. Create todos table

```bash
supabase --workdir tests migrations up
```

2. Run RLS policy tests

```bash
./tests/postgrest.sh
```
