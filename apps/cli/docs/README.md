# CLI Reference

Source content for the [CLI reference](https://supabase.com/docs/reference/cli) published on the Supabase docs site.

- `supabase/` — long-form command descriptions, one file per command path
- `templates/examples.yaml` — per-command usage examples, keyed by doc id

## Local Preview

For CLI contributors, preview reference changes in the real website before publishing:

1. Clone [supabase/supabase](https://github.com/supabase/supabase) into a separate directory.
   Follow the docs app's [local setup instructions](https://github.com/supabase/supabase/blob/master/apps/docs/DEVELOPERS.md#local-setup)
   to install its dependencies and configure the development environment.
2. In this CLI repository, install dependencies with `pnpm install --frozen-lockfile`, then run
   `pnpm exec turbo run @supabase/config#build` from the repository root.
3. From this repository's `apps/cli` directory, generate and write the preview:

   ```bash
   set -o pipefail
   bun scripts/generate-docs-spec.ts 0.0.0 | bun scripts/publish-docs-spec.ts --version 0.0.0 --local /absolute/path/to/supabase
   ```

   Replace the path with the root of your `supabase/supabase` checkout. A relative path resolves
   from the current directory. Both version arguments must match; `0.0.0` is a preview value.

4. Start that checkout's docs app using its linked local setup instructions, then visit
   `/docs/reference/cli/supabase-init` on the local server to inspect a rendered command page.
   Rerun the pipe after changing CLI documentation.

`--local` overwrites `apps/docs/spec/cli_v1_commands.yaml` in the supplied checkout using the
same formatting as release publishing. Save any edits to that file first. If formatting fails,
the file contains the unformatted generated spec; fix the error and rerun the pipe. The target
directory must already exist. Local mode does not clone, commit, push, or open a PR, and needs no GitHub
credentials. Add `--dry-run` to validate the input and print the destination without writing.

This preview writes only the command-reference spec, not sidebar entries or JSON Schemas.
New commands still need an entry in the website's
[common-cli-sections.json](https://github.com/supabase/supabase/blob/master/apps/docs/spec/common-cli-sections.json)
to appear in the reference.

## Release Publishing

The `docs` job in `.github/workflows/release.yml` publishes the reference on every stable
release: it pipes the generator into `scripts/publish-docs-spec.ts`, which formats the spec,
pushes the `cli/ref-doc` branch in [supabase/supabase](https://github.com/supabase/supabase),
and opens a PR when none is open. When the spec is already published and a PR is open
or not needed, the run is a no-op.
Later releases add commits on top of an open `cli/ref-doc` PR instead of rewriting it, so
fixes committed onto the branch survive.

To publish by hand, run the same pipe the job runs:

```bash
bun scripts/generate-docs-spec.ts <version> | bun scripts/publish-docs-spec.ts --version <version> [--dry-run]
```

The same job then publishes the config, project-config and `supabase.lock` JSON Schemas from
`apps/cli/schemas` with `scripts/publish-schemas.ts`. It copies each schema's current
(highest) `v<N>.json` into `apps/www/public/schemas` on the `cli/schemas` branch in supabase/supabase,
serving it at `https://supabase.com/schemas/<name>/v<N>.json`, opens a PR when the files differ, and
arms auto-merge, which squash-merges once a reviewer approves. Lower versions are frozen: the script
never writes them and refuses to run when supabase.com already serves a higher version than the
current one. Both publishers share the clone, branch, commit and PR flow in
`scripts/publish-pull-request.ts`. A failed publish of either pages Slack; rerun the "Publish to
supabase.com" job.

Regenerate the committed schemas from the repository root before publishing:

```bash
pnpm exec turbo run supabase#schemas:generate
```

This builds `@supabase/config`, copies its post-processed schemas, and generates the lock schema.
`pnpm run build` and `pnpm run generate` also run this task. Public schema URLs stay independent
of their location in this repository.

From `apps/cli`, publish with:

```bash
bun scripts/publish-schemas.ts --version <version> [--dry-run]
```

## Maintenance

When adding or changing a command or flag, update the matching entries in
`src/docs/docs-spec.tables.ts` — each table's doc comment says
when it applies: `TAGS`, `DEFAULT_OVERRIDES`, `REQUIRED`, `EXPERIMENTAL` (and
`_OPTIONAL`), `EXCLUDED` (whole commands), `EXCLUDED_FLAGS`, `ARG_OVERRIDES`,
`CHOICE_OVERRIDES`, `EXTRA_FLAGS`. The spec build fails on entries that no
longer resolve against the command tree, but new commands and flags must be
added by hand — nothing detects a missing entry for a new surface.
