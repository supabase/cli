# CLI reference

Source content for the [CLI reference](https://supabase.com/docs/reference/cli) published on the Supabase docs site.

- `withDocs` on a `*.command.ts` (`src/docs/command-docs.ts`) — sidebar category, page body
  imported from the sibling `*.docs.md`, examples, experimental and deprecated markers
- `cliFlag`, `cliArgument` and `makeCommand` (`src/shared/cli/cli-params.ts`) — every flag
  and argument is built through them, which records its default, required badge,
  visibility and variadic minimum for the reference
- `supabase/` — long-form command descriptions, one file per command path, for commands without
  a `withDocs` body
- `templates/examples.yaml` — per-command usage examples, keyed by doc id, for commands without
  `withDocs` examples

## Build

```bash
bun scripts/generate-docs-spec.ts [--prerelease] [--sections common-cli-v3-sections.json] > cli_v3_commands.yaml
```

The spec is `clispec 002`. `--sections` also writes the docs-site sidebar, generated from the
`DOCS_CATEGORIES` categories, so it is never edited by hand. To preview both in a local
supabase/supabase checkout:

```bash
bun scripts/publish-docs-spec.ts --local ../../../supabase --version v2
bun scripts/publish-docs-spec.ts --local ../../../supabase --version v3 --prerelease
```

The v2 preview reuses this tree's command bodies, so it is only a layout preview; the published
v2 reference comes from the v2 release branch.

## Release

The `docs` job in `.github/workflows/release.yml` publishes the reference on every stable
release: it pipes the generator into `scripts/publish-docs-spec.ts`, which formats the spec,
pushes the `cli/ref-doc` branch in [supabase/supabase](https://github.com/supabase/supabase),
and opens a PR when none is open. When the spec is already published and a PR is open
or not needed, the run is a no-op.
Later releases add commits on top of an open `cli/ref-doc` PR instead of rewriting it, so
fixes committed onto the branch survive.

The release PR carries only the spec, so new commands also need an entry in
the major's sidebar file in `apps/docs/spec/` (`common-cli-sections.json` for v2,
`common-cli-v3-sections.json` for v3); copy it from the `--sections` output.

To publish by hand, run the same pipe the job runs:

```bash
bun scripts/generate-docs-spec.ts <version> | bun scripts/publish-docs-spec.ts --version <version> [--dry-run]
```

The same job then publishes the config, project-config and `supabase.lock` JSON Schemas from
`apps/docs/public/schemas` with `scripts/publish-schemas.ts`. It copies each schema's current
(highest) `v<N>.json` into `apps/www/public/schemas` on the `cli/schemas` branch in supabase/supabase,
serving it at `https://supabase.com/schemas/<name>/v<N>.json`, opens a PR when the files differ, and
arms auto-merge, which squash-merges once a reviewer approves. Lower versions are frozen: the script
never writes them and refuses to run when supabase.com already serves a higher version than the
current one. Both publishers share the clone, branch, commit and PR flow in
`scripts/publish-pull-request.ts`. A failed publish of either pages Slack; rerun the "Publish to
supabase.com" job.

```bash
bun scripts/publish-schemas.ts --version <version> [--dry-run]
```

## Maintenance

Describe a new command with `withDocs` and declare its flags and arguments with `cliFlag` and
`cliArgument` inside a `makeCommand` config; `cli-params.unit.test.ts` fails on any param built
another way. A default the handler applies, or a required badge on a parse-optional flag, goes in
the constructor's `docs` field. Commands not yet migrated still read
`src/docs/docs-spec.tables.ts` — each table's doc comment says when it applies: `TAGS`,
`CATEGORY`, `EXPERIMENTAL` (and `_OPTIONAL`), `EXCLUDED` (whole commands), `EXCLUDED_FLAGS`,
`CHOICE_OVERRIDES`, `EXTRA_FLAGS`. The spec build fails on entries that no longer resolve
against the command tree, on a command described by both `withDocs` and a table, and on a
command with no category.
