# CLI reference

Source content for the [CLI reference](https://supabase.com/docs/reference/cli) published on the Supabase docs site.

- `supabase/` — long-form command descriptions, one file per command path
- `templates/examples.yaml` — per-command usage examples, keyed by doc id

## Build

```bash
bun scripts/generate-docs-spec.ts > cli_v1_commands.yaml
```

## Release

1. Clone the [supabase/supabase](https://github.com/supabase/supabase) repo
2. Copy over the CLI reference and reformat

```bash
mv ../cli/apps/cli/cli_v1_commands.yaml apps/docs/spec/
npx prettier -w apps/docs/spec/cli_v1_commands.yaml
```

3. If there are new commands added, update [common-cli-sections.json](https://github.com/supabase/supabase/blob/master/apps/docs/spec/common-cli-sections.json) manually

## Maintenance

When adding or changing a command or flag, update the matching entries in
`src/legacy/docs/legacy-docs-spec.tables.ts` — each table's doc comment says
when it applies: `TAGS`, `DEFAULT_OVERRIDES`, `REQUIRED`, `EXPERIMENTAL` (and
`_OPTIONAL`), `EXCLUDED` (whole commands), `EXCLUDED_FLAGS`, `ARG_OVERRIDES`,
`CHOICE_OVERRIDES`, `EXTRA_FLAGS`. The spec build fails on entries that no
longer resolve against the command tree, but new commands and flags must be
added by hand — nothing detects a missing entry for a new surface.
