# Supabase CLI MkII (WIP)

[Supabase](https://supabase.io) is an open source Firebase alternative. We're building the features of Firebase using enterprise-grade open source tools.

This repository contains all the functionality for our CLI. It is still under heavy development.

- [x] Running Supabase locally
- [ ] Self-hosting
- [ ] Managing database migrations (in progress)
- [ ] Pushing your local changes to production
- [ ] Manage your Supabase Account
- [ ] Manage your Supabase Projects
- [ ] Generating types directly from your database schema
- [ ] Generating API and validation schemas from your database

## Getting started

```sh
go run main.go help # Go >= v1.16
```

### Commands:

- `supabase init`: Initialize project
- `supabase start`: Start Supabase locally
- `supabase db pull`: Dump schema and create a new migration file
- `supabase db push`: Recreate local database with current migration history

---

## Sponsors

[![New Sponsor](https://user-images.githubusercontent.com/10214025/90518111-e74bbb00-e198-11ea-8f88-c9e3c1aa4b5b.png)](https://github.com/sponsors/supabase)
