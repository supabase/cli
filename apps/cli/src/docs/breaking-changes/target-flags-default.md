In v2, `db push` and `db pull` ran against the linked project unless you passed `--local`. In v3
they run against the local database, so a bare command no longer reaches production.

Before (v2):

```sh
supabase db push
supabase db pull
```

After (v3), to keep targeting the linked project:

```sh
supabase db push --remote
supabase db pull --remote
```

`--remote=<ref>`, `--remote=<branch>` and `--remote=<url>` reach another project, a branch of the
linked project, or a database URL.

`--linked` still works in v3 as a hidden alias and prints this warning; v4 removes it:

```text
--linked is deprecated and will be removed in v4. Use --remote instead
```

In a linked checkout, a command run without `--remote` prints a hint on stderr naming the target
it resolved:

```text
Target: local stack (127.0.0.1:54322) · default; pass --remote for <name> (<ref>)
```
