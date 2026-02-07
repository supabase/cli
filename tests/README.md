## Local e2e tests

0. Install websocat

```bash
brew install websocat
```

1. Start local stack

```bash
supabase --workdir tests start
```

2. Run all tests

```bash
./e2e-test.sh supabase
```

### Auth test

1. Run user signup tests

```bash
./tests/auth.sh
```

### PostgREST test

1. Run RLS policy tests

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
