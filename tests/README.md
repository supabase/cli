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

### Storage test

1. Run storage bucket tests

```bash
./tests/storage.sh
```

### Realtime test

1. Join a room and broadcast

```bash
./tests/realtime.sh
```

### Edge Function test

1. Invoke hello-world function

```bash
./tests/edge-runtime.sh
```
