# CLI Reference

Source content for the [CLI reference](https://supabase.com/docs/reference/cli) published on the Supabase docs site.

Long-form command descriptions live under `supabase/`, one file per command path.
For CLI contributors, author usage examples with `Command.withExamples` in command definitions.
Terminal help and the website reference use these same invocations and descriptions, without sample
output. Examples without descriptions use their invocation as the website title.

## Command Description Markdown

For CLI contributors, command descriptions, short descriptions, argument and flag descriptions,
and example captions share a Markdown contract across terminal help and the generated reference.
Use ordinary paragraphs, emphasis, inline code, links, and fenced or indented code blocks.
Use code blocks for shell instructions that readers need to copy. Put literal placeholders such
as `--remote=<ref>` and `supabase/notebooks/<name>.json` inside code spans.

Headings, lists, blockquotes, thematic breaks, tables, images, and raw HTML are prohibited in
these fields. Use paragraph labels instead of headings. Long-form page bodies under `supabase/`
and command strings in examples are outside this restriction.

Terminal rendering preserves paragraph separation, visible link destinations, and code-block
line breaks without wrapping or borders. Code blocks receive four spaces of presentation indent;
the surrounding help formatter can add more. Descriptions containing tabs retain their source
because Bun expands tabs even inside fenced code. Prefer spaces when authoring new descriptions.
Unsupported structures also retain their source at runtime, but fail the authoring check.
JSON output and reference generation receive the original Markdown, not terminal escape codes.

The authoring check runs with CLI unit tests and reports the command path, description field,
and unsupported structure. From `apps/cli`, run:

```sh
pnpm run test:unit src/shared/output/description-contract.unit.test.ts
```

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

Before writing a local preview or running Git, the publisher validates the generated `clispec 001`
fields, including flags and examples. Command IDs and subcommand links must match the documented
command tree in the current checkout, excluding unlisted and explicitly excluded commands.
Generate and publish from the same checkout; duplicate, missing, or unexpected commands fail validation.

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
