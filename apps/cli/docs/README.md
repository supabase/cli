# CLI reference

Source content for the [CLI reference](https://supabase.com/docs/reference/cli) published on the Supabase docs site.

- `supabase/` — long-form command descriptions, one file per command path
- `templates/examples.yaml` — per-command usage examples, keyed by doc id

## Build

```bash
bun scripts/generate-docs-spec.ts > cli_v1_commands.yaml
```

## Release

The `docs` job in `.github/workflows/release.yml` publishes the reference on every stable
release: it pipes the generator into `scripts/publish-docs-spec.ts`, which formats the spec,
pushes the `cli/ref-doc` branch in [supabase/supabase](https://github.com/supabase/supabase),
and opens a PR when none is open. When the spec is already published and a PR is open
or not needed, the run is a no-op.
Later releases add commits on top of an open `cli/ref-doc` PR instead of rewriting it, so
fixes committed onto the branch survive.

New commands also need an entry in
[common-cli-sections.json](https://github.com/supabase/supabase/blob/master/apps/docs/spec/common-cli-sections.json)
— the sidebar decides which pages exist, and a command without an entry is silently
dropped from the docs site.

To publish by hand, run the same pipe the job runs:

```bash
bun scripts/generate-docs-spec.ts <version> | bun scripts/publish-docs-spec.ts --version <version> [--dry-run]
```

## Maintenance

When adding or changing a command or flag, update the matching entries in
`src/legacy/docs/legacy-docs-spec.tables.ts` — each table's doc comment says
when it applies: `TAGS`, `DEFAULT_OVERRIDES`, `REQUIRED`, `EXPERIMENTAL` (and
`_OPTIONAL`), `EXCLUDED` (whole commands), `EXCLUDED_FLAGS`, `ARG_OVERRIDES`,
`CHOICE_OVERRIDES`, `EXTRA_FLAGS`. The spec build fails on entries that no
longer resolve against the command tree, but new commands and flags must be
added by hand — nothing detects a missing entry for a new surface.
